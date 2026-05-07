import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import { unipileFetch, canonicalChannel } from "./lib/unipile-v2";

/**
 * Fetch historical email and LinkedIn messages for a contact.
 * Searches Microsoft Graph for email history and Unipile for LinkedIn messages,
 * then inserts them as message records linked to the contact.
 *
 * Triggered on-demand from the Contacts page "Fetch History" button.
 */
export const fetchEntityHistory = task({
  id: "fetch-entity-history",
  retry: { maxAttempts: 2 },
  run: async (payload: { contact_id: string }) => {
    const supabase = getSupabaseAdmin();
    const { contact_id } = payload;

    // 1. Get the contact
    const { data: contact, error: contactErr } = await supabase
      .from("contacts")
      .select("id, email, phone, linkedin_url, full_name")
      .eq("id", contact_id)
      .single();

    if (contactErr || !contact) {
      logger.error("Contact not found", { contact_id });
      return { error: "Contact not found" };
    }

    const results: { email_history: any; linkedin_history: any } = {
      email_history: { searched: false, inserted: 0 },
      linkedin_history: { searched: false, inserted: 0 },
    };

    // 2. Search email history via Microsoft Graph
    if (contact.email) {
      try {
        // Get active Microsoft accounts
        const { data: msAccounts } = await supabase
          .from("integration_accounts")
          .select("id, owner_user_id, access_token")
          .eq("provider", "microsoft")
          .eq("is_active", true);

        for (const acct of msAccounts || []) {
          if (!acct.access_token) continue;

          const searchResp = await fetch(
            `https://graph.microsoft.com/v1.0/me/messages?$filter=from/emailAddress/address eq '${contact.email}' or toRecipients/any(r:r/emailAddress/address eq '${contact.email}')&$select=subject,bodyPreview,from,toRecipients,sentDateTime,receivedDateTime&$top=50&$orderby=receivedDateTime desc`,
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

          // Find or create conversation for this contact's email history
          const convId = `email_history_${contact_id}`;
          const { data: existingConv } = await supabase
            .from("conversations")
            .select("id")
            .eq("id", convId)
            .maybeSingle();

          if (!existingConv) {
            await supabase.from("conversations").insert({
              id: convId,
              contact_id,
              channel: "email",
              subject: `Email history: ${contact.full_name || contact.email}`,
              account_id: acct.id,
            } as any);
          }

          for (const email of emails) {
            const fromAddr = email.from?.emailAddress?.address?.toLowerCase();
            const direction = fromAddr === contact.email?.toLowerCase() ? "inbound" : "outbound";
            const externalId = email.id;

            // Skip if already imported
            const { data: existing } = await supabase
              .from("messages")
              .select("id")
              .eq("external_message_id", externalId)
              .maybeSingle();

            if (existing) continue;

            await supabase.from("messages").insert({
              conversation_id: convId,
              contact_id,
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
          break; // Use first working account
        }
      } catch (err: any) {
        logger.warn(`Email history fetch failed: ${err.message}`);
      }
    }

    // 3. Search LinkedIn history via Unipile v2
    //    GET /api/v2/{account_id}/chats/{chat_id}/messages
    if (contact.linkedin_url) {
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
          // Get contact's Unipile provider_id
          const { data: channel } = await supabase
            .from("contact_channels")
            .select("provider_id, unipile_id, external_conversation_id")
            .eq("contact_id", contact_id)
            .eq("channel", "linkedin")
            .maybeSingle();

          if (channel?.external_conversation_id) {
            // Bucket inbound history under the right channel.
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
                  contact_id,
                  channel: channelBucket,
                  direction,
                  body: msg.text || msg.body,
                  sender_name: msg.sender_name || contact.full_name,
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

    logger.info("Entity history fetched", results);
    return results;
  },
});
