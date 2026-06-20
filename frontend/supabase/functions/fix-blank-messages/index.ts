import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function getAppSetting(key: string): Promise<string> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", key).single();
  if (!data?.value) throw new Error(`Missing app_settings.${key}`);
  return data.value;
}

/**
 * Try every known field path Unipile uses for message text across
 * LinkedIn Classic, Recruiter, and Sales Nav.
 */
function extractBody(msg: any): string {
  // Primary text fields
  const raw =
    msg.text ??
    msg.body ??
    msg.content ??
    msg.message ??
    msg.message_text ??
    msg.body_html ??
    msg.rendered_body ??
    msg.text_html ??
    msg.inmail_body ??
    msg.inmail_text ??
    null;

  if (!raw) return "";

  // Strip HTML if needed
  const str = String(raw);
  if (str.startsWith("<")) {
    return str.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, " ").trim();
  }
  return str.trim();
}

/**
 * Returns true if the message is a LinkedIn system/event message
 * that will never have meaningful text (connection acceptance, etc.)
 */
function isSystemMessage(msg: any): boolean {
  const subtype = String(msg.subtype ?? msg.message_type ?? msg.event_type ?? "").toLowerCase();
  const systemSubtypes = [
    "connection", "connected", "inmail_opened", "profile_view",
    "typing", "seen", "delivered", "system", "event", "reaction",
  ];
  if (systemSubtypes.some((s) => subtype.includes(s))) return true;

  // Attachment-only messages with no text
  const hasAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
  const hasNoText = !msg.text && !msg.body && !msg.content && !msg.message && !msg.rendered_body;
  if (hasAttachments && hasNoText) return false; // keep with placeholder

  return false;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const write = (obj: any) => writer.write(enc.encode(JSON.stringify(obj) + "\n"));

  (async () => {
    try {
      const unipileBaseUrl = await getAppSetting("UNIPILE_BASE_URL");
      const unipileApiKey = await getAppSetting("UNIPILE_API_KEY");
      const uniHeaders = { "X-API-KEY": unipileApiKey, Accept: "application/json" };

      // Fetch all blank messages with their chat/account info
      const { data: blankMessages, error } = await supabase
        .from("messages")
        .select("id, unipile_message_id, unipile_chat_id, integration_account_id")
        .in("channel", ["linkedin_recruiter", "linkedin", "linkedin_sales_nav"])
        .eq("body", "")
        .not("unipile_message_id", "is", null)
        .not("unipile_chat_id", "is", null);

      if (error) throw new Error(`Query error: ${error.message}`);

      await write({ event: "start", blank_count: blankMessages?.length ?? 0 });

      // Group by chat + account to minimise API calls
      const groups = new Map<string, { chatId: string; accountId: string; messageIds: Map<string, string> }>();
      for (const m of blankMessages ?? []) {
        const key = `${m.unipile_chat_id}::${m.integration_account_id}`;
        if (!groups.has(key)) groups.set(key, { chatId: m.unipile_chat_id, accountId: m.integration_account_id, messageIds: new Map() });
        groups.get(key)!.messageIds.set(m.unipile_message_id, m.id);
      }

      // Load unipile_account_id for each integration_account_id
      const integrationIds = [...new Set((blankMessages ?? []).map((m: any) => m.integration_account_id))];
      const { data: integrations } = await supabase
        .from("integration_accounts")
        .select("id, unipile_account_id")
        .in("id", integrationIds);
      const integrationMap = new Map((integrations ?? []).map((i: any) => [i.id, i.unipile_account_id]));

      let updated = 0, deleted = 0, attachmentPlaceholder = 0, fetchErrors = 0;

      for (const [, group] of groups) {
        const unipileAccountId = integrationMap.get(group.accountId);
        if (!unipileAccountId) continue;

        try {
          // Fetch messages for this chat
          const msgsResp = await fetch(
            `${unipileBaseUrl}/api/v1/chats/${group.chatId}/messages?account_id=${unipileAccountId}&limit=200`,
            { headers: uniHeaders },
          );

          if (!msgsResp.ok) {
            await write({ event: "fetch_error", chat_id: group.chatId, status: msgsResp.status });
            fetchErrors++;
            continue;
          }

          const msgsData = await msgsResp.json();
          const messages: any[] = msgsData.items ?? msgsData.messages ?? msgsData.data ?? [];

          // Process each message we're interested in
          for (const [unipileMessageId, dbMessageId] of group.messageIds) {
            const msg = messages.find((m: any) => m.id === unipileMessageId);

            if (!msg) {
              // Message not found in Unipile — probably deleted, remove it
              await supabase.from("messages").delete().eq("id", dbMessageId);
              deleted++;
              await write({ event: "deleted_not_found", message_id: dbMessageId, unipile_id: unipileMessageId });
              continue;
            }

            const body = extractBody(msg);

            if (body.length > 0) {
              // Has content — update
              await supabase.from("messages")
                .update({ body, updated_at: new Date().toISOString() })
                .eq("id", dbMessageId);
              updated++;
            } else if (isSystemMessage(msg)) {
              // Confirmed system/event message — delete
              await supabase.from("messages").delete().eq("id", dbMessageId);
              deleted++;
              await write({ event: "deleted_system", message_id: dbMessageId });
            } else if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
              // Attachment-only — set a placeholder so it's not blank
              const placeholder = `[Attachment: ${(msg.attachments as any[]).map((a: any) => a.name ?? a.file_name ?? a.type ?? "file").join(", ")}]`;
              await supabase.from("messages")
                .update({ body: placeholder, updated_at: new Date().toISOString() })
                .eq("id", dbMessageId);
              attachmentPlaceholder++;
            } else {
              // Truly empty and not a system message — delete (no value)
              await supabase.from("messages").delete().eq("id", dbMessageId);
              deleted++;
            }
          }
        } catch (err: any) {
          await write({ event: "error", chat_id: group.chatId, msg: err.message });
          fetchErrors++;
        }

        // Brief pause between chat API calls
        await new Promise((r) => setTimeout(r, 300));
      }

      await write({ event: "done", updated, deleted, attachmentPlaceholder, fetchErrors, total_chats: groups.size });
    } catch (err: any) {
      await write({ event: "fatal", error: err.message });
    } finally {
      await writer.close();
    }
  })();

  return new Response(readable, { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
});
