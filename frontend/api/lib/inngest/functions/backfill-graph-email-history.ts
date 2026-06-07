import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { getMicrosoftAccessToken } from "../../../../src/server-lib/microsoft-graph.js";
import { normalizeEmail } from "../../../../src/server-lib/resume-parsing.js";
import { isMarketingEmail } from "../../../../src/server-lib/marketing-blocklist.js";

/**
 * One-off historical email backfill straight from Microsoft Graph (app-only).
 *
 * Walks each mailbox's Exchange history newest→oldest within [since, until]
 * and ingests ONLY mail whose counterparty is an existing candidate/client
 * (CRM-people-only) — so 8 years of newsletters/personal mail are skipped and
 * each kept message attaches to the right record. Reuses the same
 * conversation/message shape as backfill-emails.ts (the Unipile safety-net
 * backfill) so the Inbox renders it identically; tags `provider:
 * 'microsoft_graph'` and dedups on `external_message_id` against everything
 * already imported (unipile / microsoft / pst_backfill), so re-runs and
 * overlap with the live path never double-insert.
 *
 * Why Graph and not Unipile: Unipile only holds its recent sync window, and
 * the team mailboxes are currently inactive on Unipile anyway. Graph app-only
 * reads the Exchange mailbox directly, as far back as retention allows.
 *
 * IMPORTANT: app-only `Mail.Read` is unproven on this app registration (the
 * historical `provider:'microsoft'` ingestion used delegated refresh tokens,
 * now defunct). So this runs **dryRun by default** — the first dry run is the
 * probe: it reports per-mailbox whether Graph returned mail (200) or a 403,
 * how far back the mailbox reaches, and how many messages would match a CRM
 * person — all without writing a single row. Flip `dryRun:false` only once a
 * dry run confirms access.
 *
 * Trigger:
 *   inngest.send({ name: "ops/backfill-graph-email.requested",
 *                  data: { dryRun: true } })           // probe everything
 *   inngest.send({ name: "ops/backfill-graph-email.requested",
 *                  data: { dryRun: false,
 *                          mailboxes: ["chris.sullivan@emeraldrecruit.com"] } })
 */

const GRAPH = "https://graph.microsoft.com/v1.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type EmailEntity = { type: "candidate" | "contact"; id: string; owner_user_id: string | null };

interface GraphGetResult {
  ok: boolean;
  status: number;
  data: any;
}

/** GET a Graph URL with the app-only token, honoring 429/503 Retry-After
 *  with bounded backoff. Body comes back as plain text (Prefer header) so we
 *  store readable bodies without HTML-stripping. */
async function graphGet(url: string, token: string, attempt = 0): Promise<GraphGetResult> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: 'outlook.body-content-type="text"',
      },
    });
  } catch (err: any) {
    if (attempt < 4) {
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      return graphGet(url, token, attempt + 1);
    }
    return { ok: false, status: 0, data: { error: { message: String(err?.message || err) } } };
  }

  if ((resp.status === 429 || resp.status === 503) && attempt < 5) {
    const retryAfter = Number(resp.headers.get("retry-after"));
    const waitMs = (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : Math.min(60, 2 ** attempt)) * 1000;
    await sleep(waitMs);
    return graphGet(url, token, attempt + 1);
  }

  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    /* empty / non-JSON body */
  }
  return { ok: resp.ok, status: resp.status, data };
}

/** email → candidate/contact map across every address column we match on
 *  (primary / work / personal / secondary). type='client' rows map to the
 *  `contact_id` column, everything else to `candidate_id`. */
async function buildEmailLookup(supabase: any): Promise<Map<string, EmailEntity>> {
  const map = new Map<string, EmailEntity>();
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("people")
      .select("id, type, owner_user_id, primary_email, work_email, personal_email, secondary_emails")
      .is("deleted_at", null)
      .in("type", ["candidate", "client"])
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`people lookup failed: ${error.message}`);
    const rows = data ?? [];
    for (const p of rows) {
      const entity: EmailEntity = {
        type: p.type === "client" ? "contact" : "candidate",
        id: p.id,
        owner_user_id: p.owner_user_id ?? null,
      };
      const addrs: any[] = [
        p.primary_email,
        p.work_email,
        p.personal_email,
        ...(Array.isArray(p.secondary_emails) ? p.secondary_emails : []),
      ];
      for (const a of addrs) {
        const e = normalizeEmail(a || "");
        if (e && !map.has(e)) map.set(e, entity);
      }
    }
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

interface MailboxResult {
  mailbox: string;
  scanned: number;
  matched: number;
  inserted: number;
  duplicates: number;
  skipped: number;
  errors: number;
  pages: number;
  permissionError: string | null;
  earliestAvailable: string | null;
  oldestSeen: string | null;
  exhausted: boolean;
}

async function processMailbox(
  supabase: any,
  token: string,
  account: any,
  lookup: Map<string, EmailEntity>,
  sinceIso: string,
  untilIso: string,
  pageSize: number,
  maxPages: number,
  dryRun: boolean,
  logger: any,
): Promise<MailboxResult> {
  const mailboxEmail = normalizeEmail(account.email_address);
  const res: MailboxResult = {
    mailbox: account.email_address,
    scanned: 0,
    matched: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    pages: 0,
    permissionError: null,
    earliestAvailable: null,
    oldestSeen: null,
    exhausted: false,
  };

  // Cheap retention probe: the single oldest message Graph will return.
  if (dryRun) {
    const probe = new URLSearchParams({
      $select: "receivedDateTime",
      $top: "1",
      $orderby: "receivedDateTime asc",
    });
    const pr = await graphGet(
      `${GRAPH}/users/${encodeURIComponent(account.email_address)}/messages?${probe.toString()}`,
      token,
    );
    if (pr.ok) res.earliestAvailable = pr.data?.value?.[0]?.receivedDateTime ?? null;
    else if (pr.status === 401 || pr.status === 403) {
      res.permissionError = `Graph ${pr.status}: ${JSON.stringify(pr.data?.error?.message ?? pr.data).slice(0, 200)}`;
      return res; // no point paging if reads are denied
    }
  }

  const select =
    "id,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,conversationId,isRead";
  const params = new URLSearchParams({
    $select: select,
    $top: String(pageSize),
    $orderby: "receivedDateTime desc",
    $filter: `receivedDateTime ge ${sinceIso} and receivedDateTime le ${untilIso}`,
  });
  let url: string | null = `${GRAPH}/users/${encodeURIComponent(account.email_address)}/messages?${params.toString()}`;

  while (url && res.pages < maxPages) {
    const page = await graphGet(url, token);
    if (!page.ok) {
      if (page.status === 401 || page.status === 403) {
        res.permissionError = `Graph ${page.status}: ${JSON.stringify(page.data?.error?.message ?? page.data).slice(0, 200)}`;
      } else {
        res.errors++;
        res.permissionError = res.permissionError ?? `Graph ${page.status}`;
      }
      break;
    }
    res.pages++;
    const items: any[] = page.data?.value ?? [];
    if (items.length === 0) {
      res.exhausted = true;
      break;
    }

    // Batch dedup: one query per page for every id we might insert under.
    const idSet = new Set<string>();
    for (const m of items) {
      if (m.internetMessageId) idSet.add(m.internetMessageId);
      if (m.id) idSet.add(m.id);
    }
    const existing = new Set<string>();
    if (idSet.size) {
      const { data: ex } = await supabase
        .from("messages")
        .select("external_message_id")
        .in("external_message_id", Array.from(idSet));
      for (const r of ex ?? []) if (r.external_message_id) existing.add(r.external_message_id);
    }

    for (const m of items) {
      res.scanned++;
      const rdt: string | null = m.receivedDateTime || null;
      if (rdt && (!res.oldestSeen || rdt < res.oldestSeen)) res.oldestSeen = rdt;

      const externalMessageId: string | null = m.internetMessageId || m.id || null;
      if (!externalMessageId) {
        res.skipped++;
        continue;
      }
      if (existing.has(m.internetMessageId) || existing.has(m.id)) {
        res.duplicates++;
        continue;
      }

      const senderEmail = normalizeEmail(m.from?.emailAddress?.address || "");
      const toEmails = [
        ...(m.toRecipients || []).map((r: any) => normalizeEmail(r?.emailAddress?.address || "")),
        ...(m.ccRecipients || []).map((r: any) => normalizeEmail(r?.emailAddress?.address || "")),
      ].filter(Boolean) as string[];

      const isOutbound = !!senderEmail && senderEmail === mailboxEmail;

      // Counterparty: the first CRM person on the other end. Outbound → a
      // recipient who's in the CRM; inbound → the sender.
      let matchEmail: string | null = null;
      let entity: EmailEntity | undefined;
      if (isOutbound) {
        for (const t of toEmails) {
          const e = lookup.get(t);
          if (e) {
            matchEmail = t;
            entity = e;
            break;
          }
        }
      } else if (senderEmail) {
        entity = lookup.get(senderEmail);
        matchEmail = senderEmail;
      }

      // CRM-people-only: no counterparty in the CRM → skip entirely.
      if (!entity || !matchEmail) {
        res.skipped++;
        continue;
      }
      if (!isOutbound && isMarketingEmail(senderEmail)) {
        res.skipped++;
        continue;
      }

      res.matched++;
      if (dryRun) continue;

      const externalConversationId = m.conversationId || externalMessageId;
      const candidateId = entity.type === "candidate" ? entity.id : null;
      const contactId = entity.type === "contact" ? entity.id : null;
      const subject = m.subject ?? null;
      const bodyText = String(m.body?.content || m.bodyPreview || "");
      const preview = bodyText.slice(0, 500);
      const sentAt = m.sentDateTime || m.receivedDateTime || null;
      const receivedAt = m.receivedDateTime || sentAt;
      const senderName = m.from?.emailAddress?.name || null;

      try {
        let { data: conversation } = await supabase
          .from("conversations")
          .select("id")
          .eq("external_conversation_id", externalConversationId)
          .eq("integration_account_id", account.id)
          .maybeSingle();
        if (!conversation) {
          const { data: created, error: convErr } = await supabase
            .from("conversations")
            .insert({
              candidate_id: candidateId,
              contact_id: contactId,
              channel: "email",
              integration_account_id: account.id,
              external_conversation_id: externalConversationId,
              subject,
              last_message_preview: preview,
              last_message_at: receivedAt,
              is_read: true,
              is_archived: false,
              assigned_user_id: entity.owner_user_id ?? account.owner_user_id,
            })
            .select("id")
            .single();
          if (convErr) {
            res.errors++;
            continue;
          }
          conversation = created;
        }
        if (!conversation) {
          res.errors++;
          continue;
        }

        const { error: msgErr } = await supabase.from("messages").insert({
          conversation_id: conversation.id,
          candidate_id: candidateId,
          contact_id: contactId,
          channel: "email",
          direction: isOutbound ? "outbound" : "inbound",
          message_type: "email",
          external_message_id: externalMessageId,
          external_conversation_id: externalConversationId,
          subject,
          body: bodyText,
          sender_name: senderName,
          sender_address: isOutbound ? mailboxEmail : senderEmail || null,
          recipient_address: isOutbound ? matchEmail : mailboxEmail,
          sent_at: sentAt,
          received_at: receivedAt,
          integration_account_id: account.id,
          provider: "microsoft_graph",
          is_read: m.isRead ?? true,
        });
        if (msgErr) {
          res.errors++;
          continue;
        }
        res.inserted++;
      } catch (err: any) {
        res.errors++;
        logger.error("graph-backfill insert error", { mailbox: account.email_address, error: err.message });
      }
    }

    url = page.data?.["@odata.nextLink"] || null;
    if (!url) res.exhausted = true;
  }

  return res;
}

export const backfillGraphEmailHistory = inngest.createFunction(
  { id: "backfill-graph-email-history", name: "Backfill historical email from Microsoft Graph (CRM people only)", retries: 1 },
  { event: "ops/backfill-graph-email.requested" },
  async ({ event, step, logger }) => {
    const supabase = getSupabaseAdmin();
    const d = (event.data || {}) as any;

    const dryRun = d.dryRun !== false; // default ON — safe probe
    const pageSize = Math.min(Math.max(Number(d.pageSize) || 50, 1), 100);
    const maxPages = Math.min(Math.max(Number(d.maxPages) || 40, 1), 500);
    const depth = Number(d.depth) || 0;
    const EIGHT_YEARS_MS = 8 * 365 * 24 * 60 * 60 * 1000;
    const sinceIso = d.since || new Date(Date.now() - EIGHT_YEARS_MS).toISOString();
    const untilIso = d.until || new Date().toISOString();

    // Resolve mailboxes from integration_accounts (all email accounts; this
    // reads Exchange directly so it doesn't care whether the row is active on
    // Unipile). Optional `mailboxes` filter narrows to specific addresses.
    const { data: allAccts, error: acctErr } = await supabase
      .from("integration_accounts")
      .select("id, email_address, owner_user_id")
      .eq("account_type", "email");
    if (acctErr) {
      logger.error("mailbox lookup failed", { error: acctErr.message });
      return { error: acctErr.message };
    }
    let accounts = (allAccts ?? []).filter((a: any) => a.email_address);
    if (Array.isArray(d.mailboxes) && d.mailboxes.length) {
      const want = new Set(d.mailboxes.map((m: string) => String(m).toLowerCase()));
      accounts = accounts.filter((a: any) => want.has(String(a.email_address).toLowerCase()));
    }
    if (!accounts.length) return { error: "no_mailboxes_matched" };

    const token = await step.run("graph-token", async () => getMicrosoftAccessToken());

    // Build the ~11k-address lookup once; serialize to survive step memoization.
    const lookupEntries = (await step.run("build-email-lookup", async () => {
      const m = await buildEmailLookup(supabase);
      return Array.from(m.entries());
    })) as [string, EmailEntity][];
    const lookup = new Map<string, EmailEntity>(lookupEntries);

    logger.info("backfill-graph-email start", {
      dryRun,
      crmAddresses: lookup.size,
      mailboxes: accounts.map((a: any) => a.email_address),
      sinceIso,
      untilIso,
      depth,
    });

    const results: MailboxResult[] = [];
    for (const account of accounts) {
      const r = await processMailbox(
        supabase,
        token,
        account,
        lookup,
        sinceIso,
        untilIso,
        pageSize,
        maxPages,
        dryRun,
        logger,
      );
      results.push(r);
      logger.info("mailbox done", r as any);
    }

    // Resumable walk: for real runs, re-enqueue each unfinished mailbox with
    // `until` set to the oldest message we saw (a stable date cursor — no
    // skiptoken expiry). Bounded by `depth` so it can never run away.
    const continuations: { mailbox: string; until: string }[] = [];
    if (!dryRun && depth < 500) {
      for (const r of results) {
        if (!r.exhausted && !r.permissionError && r.oldestSeen && r.oldestSeen > sinceIso) {
          continuations.push({ mailbox: r.mailbox, until: r.oldestSeen });
          await inngest.send({
            name: "ops/backfill-graph-email.requested",
            data: {
              since: sinceIso,
              until: r.oldestSeen,
              mailboxes: [r.mailbox],
              pageSize,
              maxPages,
              dryRun: false,
              depth: depth + 1,
            },
          });
        }
      }
    }

    const totals = results.reduce(
      (acc, r) => ({
        scanned: acc.scanned + r.scanned,
        matched: acc.matched + r.matched,
        inserted: acc.inserted + r.inserted,
        duplicates: acc.duplicates + r.duplicates,
        skipped: acc.skipped + r.skipped,
        errors: acc.errors + r.errors,
      }),
      { scanned: 0, matched: 0, inserted: 0, duplicates: 0, skipped: 0, errors: 0 },
    );

    logger.info("backfill-graph-email complete", { dryRun, totals, continuations: continuations.length });
    return { dryRun, sinceIso, untilIso, crmAddresses: lookup.size, totals, results, continuations };
  },
);
