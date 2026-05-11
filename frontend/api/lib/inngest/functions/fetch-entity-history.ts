import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/trigger/lib/supabase.js";
import {
  unipileFetch,
  canonicalChannel,
} from "../../../../src/trigger/lib/unipile-v2.js";

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

export const fetchEntityHistory = inngest.createFunction(
  {
    id: "fetch-entity-history",
    name: "Fetch entity history (Inngest)",
    retries: 2,
    // Per-entity concurrency: prevents parallel fans for the same
    // person from racing the messages-insert dedup. event.data.entity_id
    // is the new shape; legacy contact_id callers don't get a key,
    // which falls back to no concurrency cap (safe — they're rare).
    concurrency: [{ key: "event.data.entity_id", limit: 1 }],
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

    const results: { email_history: any; linkedin_history: any } = {
      email_history: { searched: false, inserted: 0 },
      linkedin_history: { searched: false, inserted: 0 },
    };

    // ── Email history via Microsoft Graph ───────────────────────────
    if (personEmail) {
      try {
        const { data: msAccounts } = await supabase
          .from("integration_accounts")
          .select("id, owner_user_id, access_token")
          .eq("provider", "microsoft")
          .eq("is_active", true);

        for (const acct of msAccounts || []) {
          if (!acct.access_token) continue;

          const searchResp = await fetch(
            `https://graph.microsoft.com/v1.0/me/messages?$filter=from/emailAddress/address eq '${personEmail}' or toRecipients/any(r:r/emailAddress/address eq '${personEmail}')&$select=subject,bodyPreview,from,toRecipients,sentDateTime,receivedDateTime&$top=50&$orderby=receivedDateTime desc`,
            { headers: { Authorization: `Bearer ${acct.access_token}` } },
          );

          if (!searchResp.ok) {
            if (searchResp.status === 401) {
              logger.info(`Token expired for account ${acct.id}`);
            }
            continue;
          }

          const emails = ((await searchResp.json()) as any).value || [];
          results.email_history.searched = true;

          const convId = `email_history_${entityId}`;
          const { data: existingConv } = await supabase
            .from("conversations")
            .select("id")
            .eq("id", convId)
            .maybeSingle();

          if (!existingConv) {
            await supabase.from("conversations").insert({
              id: convId,
              [entityType === "candidate" ? "candidate_id" : "contact_id"]: entityId,
              channel: "email",
              subject: `Email history: ${person.full_name || personEmail}`,
              account_id: acct.id,
            } as any);
          }

          for (const email of emails) {
            const fromAddr = email.from?.emailAddress?.address?.toLowerCase();
            const direction = fromAddr === personEmail.toLowerCase() ? "inbound" : "outbound";
            const externalId = email.id;

            const { data: existing } = await supabase
              .from("messages")
              .select("id")
              .eq("external_message_id", externalId)
              .maybeSingle();

            if (existing) continue;

            await supabase.from("messages").insert({
              conversation_id: convId,
              [entityType === "candidate" ? "candidate_id" : "contact_id"]: entityId,
              channel: "email",
              direction,
              subject: email.subject,
              body: email.bodyPreview,
              sender_name: email.from?.emailAddress?.name,
              sender_address: fromAddr,
              sent_at: email.sentDateTime,
              received_at: email.receivedDateTime,
              external_message_id: externalId,
              provider: "microsoft_graph",
            } as any);

            results.email_history.inserted++;
          }
          break;
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
            try {
              const data: any = await unipileFetch(
                supabase,
                liAcct.unipile_account_id,
                `chats/${encodeURIComponent(channel.external_conversation_id)}/messages`,
                { method: "GET", query: { limit: 50 } },
              );
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
                  conversation_id: channel.external_conversation_id,
                  [entityType === "candidate" ? "candidate_id" : "contact_id"]: entityId,
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

    // Stamp last_history_synced_at so the cron skips this row next pass.
    await supabase
      .from("people")
      .update({ last_history_synced_at: new Date().toISOString() } as any)
      .eq("id", entityId);

    logger.info("Entity history fetched", { entityId, entityType, ...results });
    return results;
  },
);
