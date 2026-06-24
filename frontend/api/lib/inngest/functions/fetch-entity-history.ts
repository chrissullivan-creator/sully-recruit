import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import {
  unipileFetch,
  canonicalChannel,
} from "../../../../src/server-lib/unipile-v2.js";

/**
 * Fetch historical email + LinkedIn messages for a person and insert
 * them as message records linked to the entity. Triggered:
 *   - on-demand from the Contacts/Candidates page "Fetch History" button
 *     via /api/trigger-fetch-history → contact_id payload
 *   - automatically from the `backfill-entity-histories` cron for
 *     stale-or-never-synced people (entity_id + entity_type payload)
 *   - from the resumes pipeline / DB triggers when a new person is
 *     created (TODO follow-up)
 *
 * Stamps `people.last_history_synced_at` on completion so the cron's
 * scheduling query can skip already-fresh rows.
 *
 * Backward-compatible payload shape: legacy callers send `{ contact_id }`,
 * new callers send `{ entity_id, entity_type }`. Either works.
 */
interface FetchHistoryPayload {
  /** Legacy: contact_id only (clients). */
  contact_id?: string;
  /** New: works for both candidates + contacts. */
  entity_id?: string;
  entity_type?: "candidate" | "contact";
}

// Throttle between Unipile API calls — keeps a per-person backfill from
// burning through the v1 DSN rate limit when the mass-backfill cron fans
// out 50 people/hour. ~250ms is well under one call/second per account.
const UNIPILE_THROTTLE_MS = 250;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const fetchEntityHistory = inngest.createFunction(
  {
    id: "fetch-entity-history",
    name: "Fetch entity history (Inngest)",
    retries: 2,
    // Per-entity concurrency keeps duplicate fans for the same person
    // from racing the messages-insert dedup. event.data.entity_id is
    // the new shape; legacy contact_id callers don't get a key, which
    // falls back to no concurrency cap (safe — they're rare).
    //
    // Per-account concurrency limit (3) prevents the mass-backfill cron
    // from spinning up 50 concurrent fans against the same Unipile
    // account, which would trip the v1 DSN's rate limit. The key
    // resolves at runtime from event.data.account_scope_key, which
    // backfill-entity-histories sets to the LinkedIn account id when
    // it knows one.
    concurrency: [
      { key: "event.data.entity_id", limit: 1 },
      { key: "event.data.account_scope_key", limit: 3 },
    ],
  }, { event: "messages/fetch-entity-history.requested" },
  async ({ event, logger }) => {
    const payload = event.data as FetchHistoryPayload;
    const supabase = getSupabaseAdmin();

    // Resolve which entity we're syncing — accept legacy + new shapes.
    let entityId: string;
    let entityType: "candidate" | "contact";
    if (payload.entity_id && payload.entity_type) {
      entityId = payload.entity_id;
      entityType = payload.entity_type;
    } else if (payload.contact_id) {
      entityId = payload.contact_id;
      entityType = "contact";
    } else {
      logger.warn("fetch-entity-history called with no entity id");
      return { error: "missing entity id" };
    }

    // Pull the person row out of `people` regardless of type — `contacts`
    // is a view over people-where-type=client, so the underlying record
    // is in `people` either way.
    const { data: person, error: personErr } = await supabase
      .from("people")
      .select("id, type, primary_email, work_email, personal_email, phone, linkedin_url, full_name")
      .eq("id", entityId)
      .maybeSingle();

    if (personErr || !person) {
      logger.error("Person not found", { entityId, error: personErr?.message });
      return { error: "person not found" };
    }

    const personEmail = (
      entityType === "candidate"
        ? person.personal_email || person.primary_email
        : person.work_email || person.primary_email
    ) || person.primary_email || person.personal_email || person.work_email;

    const results: {
      email_history: any;
      linkedin_history: any;
      rc_calls_backstamp: any;
    } = {
      email_history: { searched: false, inserted: 0 },
      linkedin_history: { searched: false, inserted: 0 },
      rc_calls_backstamp: { searched: false, linked: 0 },
    };

    // ── Email history via Unipile v2 ────────────────────────────────
    // Previously hit Microsoft Graph /me/messages, but we never store
    // Graph access tokens on integration_accounts anymore (all mailboxes
    // run through Unipile-hosted Outlook). The Graph branch was a
    // permanent no-op since the rename of `provider='microsoft'` →
    // `provider='email'`, which is why email history stopped
    // populating around 5/7.
    if (personEmail) {
      try {
        const { data: emailAccounts } = await supabase
          .from("integration_accounts")
          .select("id, owner_user_id, unipile_account_id, account_type, email_address")
          .eq("account_type", "email")
          .eq("is_active", true)
          .not("unipile_account_id", "is", null);

        const entityColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
        const lowerEmail = personEmail.toLowerCase();

        for (const acct of emailAccounts || []) {
          let emails: any[] = [];
          try {
            const data: any = await unipileFetch(
              supabase,
              acct.unipile_account_id,
              "emails",
              { method: "GET", query: { any_email: lowerEmail, limit: 50 } },
            );
            emails = Array.isArray(data) ? data : (data.items ?? data.emails ?? data.data ?? []);
            await sleep(UNIPILE_THROTTLE_MS);
          } catch (err: any) {
            logger.warn("Unipile email history fetch failed", {
              accountId: acct.id,
              account: acct.email_address,
              error: err.message,
            });
            await sleep(UNIPILE_THROTTLE_MS);
            continue;
          }
          if (emails.length === 0) continue;
          results.email_history.searched = true;

          // Synthetic "email history" conversation, one per (entity,
          // mailbox), so threads from each recruiter mailbox land in
          // their own conversation row.
          const historySubject = `Email history: ${person.full_name || personEmail}`;
          let convUuid: string | null = null;
          const { data: foundConv } = await supabase
            .from("conversations")
            .select("id")
            .eq(entityColumn, entityId)
            .eq("channel", "email")
            .eq("subject", historySubject)
            .eq("integration_account_id", acct.id)
            .order("created_at", { ascending: true })
            .limit(1);
          if (foundConv && foundConv.length > 0) {
            convUuid = foundConv[0].id;
          } else {
            const { data: created, error: convErr } = await supabase
              .from("conversations")
              .insert({
                [entityColumn]: entityId,
                channel: "email",
                subject: historySubject,
                integration_account_id: acct.id,
              } as any)
              .select("id")
              .single();
            if (convErr || !created) {
              logger.warn("Email history conversation create failed", { error: convErr?.message });
              continue;
            }
            convUuid = created.id;
          }

          for (const email of emails) {
            const externalId = email.id || email.message_id || email.provider_id;
            if (!externalId) continue;

            const { data: existing } = await supabase
              .from("messages")
              .select("id")
              .eq("external_message_id", externalId)
              .maybeSingle();
            if (existing) continue;

            // Unipile email shape (best-effort, tolerant of field names):
            //   from_attendee: { identifier, display_name }
            //   to_attendees:  [{ identifier, display_name }, …]
            //   is_outbound:   bool
            //   date / timestamp / sent_date: ISO timestamp
            //   subject, body / body_html / body_preview
            const fromAttendee = email.from_attendee ?? email.from ?? {};
            const fromAddr = (
              fromAttendee.identifier
                ?? fromAttendee.email
                ?? fromAttendee.emailAddress?.address
                ?? ""
            ).toLowerCase();
            const senderName = fromAttendee.display_name ?? fromAttendee.name ?? fromAttendee.emailAddress?.name ?? null;
            // Prefer Unipile's explicit flag. Without it, infer from the sender:
            // the entity's own address ⇒ inbound (they wrote to us). If the sender
            // can't be parsed at all (fromAddr empty), default to inbound rather
            // than outbound — these are pulled-in mailbox items, and the old
            // "outbound" default logged them as phantom sends with a null
            // sender_address (e.g. inbound newsletters showing as outbound).
            const direction =
              typeof email.is_outbound === "boolean"
                ? (email.is_outbound ? "outbound" : "inbound")
                : fromAddr
                  ? (fromAddr === lowerEmail ? "inbound" : "outbound")
                  : "inbound";
            const sentAt = email.date || email.timestamp || email.sent_date || email.sentDateTime || null;
            const receivedAt = email.received_date || email.receivedDateTime || sentAt;
            const body = email.body_preview || email.bodyPreview || email.body || email.body_html || "";

            await supabase.from("messages").insert({
              conversation_id: convUuid,
              [entityColumn]: entityId,
              channel: "email",
              message_type: "email",
              direction,
              subject: email.subject ?? null,
              body,
              sender_name: senderName,
              sender_address: fromAddr || null,
              sent_at: sentAt,
              received_at: receivedAt,
              external_message_id: externalId,
              provider: "unipile",
              integration_account_id: acct.id,
            } as any);

            results.email_history.inserted++;
          }
        }
      } catch (err: any) {
        logger.warn(`Email history fetch failed: ${err.message}`);
      }
    }

    // ── LinkedIn history via Unipile v2 ─────────────────────────────
    if (person.linkedin_url) {
      try {
        const { data: liAccounts } = await supabase
          .from("integration_accounts")
          .select("id, unipile_account_id, account_type")
          .or("account_type.eq.linkedin,account_type.eq.linkedin_classic,account_type.eq.linkedin_recruiter")
          .eq("is_active", true)
          .not("unipile_account_id", "is", null)
          .limit(1);

        const liAcct = liAccounts?.[0];

        if (liAcct?.unipile_account_id) {
          // Look up the resolved Unipile chat. candidate_channels +
          // contact_channels are kept in sync with the person table.
          const channelTable = entityType === "candidate" ? "candidate_channels" : "contact_channels";
          const fkColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
          const { data: channel } = await supabase
            .from(channelTable)
            .select("provider_id, unipile_id, external_conversation_id")
            .eq(fkColumn, entityId)
            .eq("channel", "linkedin")
            .maybeSingle();

          if (channel?.external_conversation_id) {
            const channelBucket = canonicalChannel(
              liAcct.account_type === "linkedin_recruiter" ? "linkedin_recruiter" : "linkedin",
            );

            // Resolve the conversations.id (UUID) for this Unipile chat. The
            // previous code shoved the chat-id string directly into
            // messages.conversation_id, which is a UUID FK — every insert
            // failed silently and no history was ever ingested.
            const entityCol = entityType === "candidate" ? "candidate_id" : "contact_id";
            let conversationUuid: string | null = null;
            const { data: foundConv } = await supabase
              .from("conversations")
              .select("id")
              .eq("external_conversation_id", channel.external_conversation_id)
              .eq("integration_account_id", liAcct.id)
              .eq("channel", channelBucket)
              .order("created_at", { ascending: true })
              .limit(1);
            if (foundConv && foundConv.length > 0) {
              conversationUuid = foundConv[0].id;
            } else {
              const { data: created, error: convErr } = await supabase
                .from("conversations")
                .insert({
                  [entityCol]: entityId,
                  channel: channelBucket,
                  external_conversation_id: channel.external_conversation_id,
                  integration_account_id: liAcct.id,
                } as any)
                .select("id")
                .single();
              if (convErr || !created) {
                logger.warn(`LinkedIn history conversation create failed: ${convErr?.message}`);
              } else {
                conversationUuid = created.id;
              }
            }

            if (!conversationUuid) throw new Error("LinkedIn history: no conversation UUID resolved");

            try {
              const data: any = await unipileFetch(
                supabase,
                liAcct.unipile_account_id,
                `chats/${encodeURIComponent(channel.external_conversation_id)}/messages`,
                { method: "GET", query: { limit: 50 } },
              );
              await sleep(UNIPILE_THROTTLE_MS);
              const messages = data.items || data || [];
              results.linkedin_history.searched = true;

              for (const msg of messages) {
                const externalId = msg.id;
                const { data: existing } = await supabase
                  .from("messages")
                  .select("id")
                  .eq("external_message_id", externalId)
                  .maybeSingle();

                if (existing) continue;

                const direction = msg.is_sender ? "outbound" : "inbound";
                await supabase.from("messages").insert({
                  conversation_id: conversationUuid,
                  [entityCol]: entityId,
                  channel: channelBucket,
                  direction,
                  body: msg.text || msg.body,
                  sender_name: msg.sender_name || person.full_name,
                  sent_at: msg.timestamp || msg.created_at,
                  external_message_id: externalId,
                  provider: "unipile",
                } as any);

                results.linkedin_history.inserted++;
              }
            } catch (err: any) {
              logger.warn(`Unipile chat messages fetch failed: ${err.message}`);
            }
          }
        }
      } catch (err: any) {
        logger.warn(`LinkedIn history fetch failed: ${err.message}`);
      }
    }

    // ── RingCentral calls back-stamp ────────────────────────────────
    // `poll-rc-calls` ingests calls into `call_logs` and tries to link
    // them to a candidate/contact at insert time. When a new person is
    // added LATER, any historical call_logs row matching their phone
    // sits unlinked (linked_entity_id IS NULL, candidate_id IS NULL).
    // Back-stamp those rows so the per-person comms timeline picks
    // them up.
    //
    // Last-10-digits match handles +1 (212) 555-… vs 2125550000 vs
    // 12125550000 normalization without an extension function.
    if (person.phone) {
      const digits = String(person.phone).replace(/\D+/g, "");
      const last10 = digits.length >= 10 ? digits.slice(-10) : null;
      if (last10) {
        const personColumn = entityType === "candidate" ? "candidate_id" : "contact_id";
        const { data: linked, error: rcErr } = await supabase
          .from("call_logs")
          .update({ [personColumn]: entityId } as any)
          .ilike("phone_number", `%${last10}%`)
          .is(personColumn, null)
          .select("id");
        if (rcErr) {
          logger.warn("RC calls back-stamp failed", { error: rcErr.message });
        } else {
          results.rc_calls_backstamp.searched = true;
          results.rc_calls_backstamp.linked = linked?.length || 0;
        }
      }
    }

    // ── Calendar events back-stamp (TODO) ───────────────────────────
    // Outlook events land in `tasks` with an attendees email list,
    // and `meeting_attendees` links each attending person. Per-person
    // backfill needs to re-scan tasks created before this person
    // existed and insert meeting_attendees rows whose email matches
    // person.primary_email / personal_email / work_email. Deferred
    // until the tasks-vs-calendar-events column shape is documented;
    // adding it blind risks duplicate attendees on shared meetings.

    // Stamp last_history_synced_at so the cron skips this row next pass.
    await supabase
      .from("people")
      .update({ last_history_synced_at: new Date().toISOString() } as any)
      .eq("id", entityId);

    logger.info("Entity history fetched", { entityId, entityType, ...results });
    return results;
  },
);
