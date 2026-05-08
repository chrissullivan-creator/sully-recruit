/**
 * Unipile v2 email send. Mirrors the shape we use for Microsoft Graph
 * sendMail so the call sites can flip between providers via the
 * USE_UNIPILE_EMAIL flag in app_settings without changing their
 * argument order.
 *
 * Endpoint (per Unipile v2 migration: account_id moves into the path):
 *   POST {UNIPILE_BASE_V2_URL}/{account_id}/emails
 *
 * Body shape (multipart when there are attachments, JSON otherwise):
 *   - subject          string
 *   - body             string (HTML)
 *   - to               JSON array of {display_name, identifier}
 *   - cc, bcc          same shape
 *   - reply_to         email message id of the previous send (threading)
 *   - attachments      file fields (multipart only)
 *
 * Auth: Bearer UNIPILE_API_KEY_V2 (falling back to UNIPILE_API_KEY).
 *
 * The Unipile account_id for the sender mailbox lives on
 * integration_accounts.unipile_account_id, looked up by the sender's
 * email address. If we don't have one, throw so the caller can fall
 * back to the Graph path.
 */
import { logger } from "@trigger.dev/sdk/v3";
import { getAppSetting } from "./supabase";

interface UnipileSendInput {
  fromEmail: string;
  to: string[] | { name?: string; address: string }[];
  subject: string;
  htmlBody: string;
  /** Microsoft InternetMessageId of the previous send to thread under
   *  (In-Reply-To equivalent in Unipile lingo). */
  inReplyTo?: string;
  /** Public URLs of files to attach. Each is fetched and posted as a
   *  multipart `attachments` field. */
  attachmentUrls?: string[];
}

export interface UnipileSendResult {
  messageId: string;
  /** Unipile-side message id we can reference for threading on the
   *  next step in the same conversation. */
  internetMessageId?: string;
}

async function resolveBaseAndKey(supabase: any) {
  const [{ data: v2Row }, { data: v1Row }, { data: v2KeyRow }, { data: v1KeyRow }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
  ]);
  const v2Base = (v2Row?.value || "").replace(/\/+$/, "")
    || (v1Row?.value || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "/api/v2");
  const apiKey = v2KeyRow?.value || v1KeyRow?.value;
  if (!v2Base || !apiKey) throw new Error("Unipile config missing");
  return { v2Base, apiKey };
}

async function resolveUnipileAccountId(supabase: any, fromEmail: string): Promise<string | null> {
  // Each recruiter has multiple integration_accounts rows sharing the
  // same email_address (email / linkedin_recruiter / phone / sms).
  // Pin account_type='email' since this helper is the email-send path
  // — without it we sometimes get back a linkedin_recruiter account_id
  // and Unipile rejects the send.
  const { data } = await supabase
    .from("integration_accounts")
    .select("unipile_account_id, unipile_provider")
    .eq("email_address", fromEmail.toLowerCase())
    .eq("account_type", "email")
    .not("unipile_account_id", "is", null)
    .limit(1)
    .maybeSingle();
  return (data?.unipile_account_id as string | null) ?? null;
}

function toRecipients(input: UnipileSendInput["to"]) {
  return (input || []).map((r) =>
    typeof r === "string"
      ? { identifier: r }
      : { display_name: r.name, identifier: r.address },
  );
}

function fileNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return (last || "attachment").replace(/^\d+_/, "");
  } catch { return "attachment"; }
}

/**
 * Send an email via Unipile Outlook. Throws on hard failure (caller
 * decides whether to fall back to Graph). The result.internetMessageId
 * is captured by the scheduler so the next email step can thread.
 */
export async function unipileSendEmail(
  supabase: any,
  input: UnipileSendInput,
): Promise<UnipileSendResult> {
  const { v2Base, apiKey } = await resolveBaseAndKey(supabase);
  const acct = await resolveUnipileAccountId(supabase, input.fromEmail);
  if (!acct) throw new Error(`No Unipile account for ${input.fromEmail}`);

  const url = `${v2Base}/${encodeURIComponent(acct)}/emails`;
  const headers: Record<string, string> = {
    "X-API-KEY": apiKey,
    Accept: "application/json",
  };

  const recipients = toRecipients(input.to);
  const attachments = (input.attachmentUrls ?? []).filter(Boolean);

  let resp: Response;

  if (attachments.length > 0) {
    // Multipart: each attachment as a `attachments` form field.
    const fd = new FormData();
    fd.append("subject", input.subject ?? "");
    fd.append("body", input.htmlBody ?? "");
    fd.append("to", JSON.stringify(recipients));
    if (input.inReplyTo) fd.append("reply_to", input.inReplyTo);
    for (const u of attachments) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) { logger.warn("Unipile email: attachment fetch failed", { u, status: r.status }); continue; }
        const buf = await r.arrayBuffer();
        const ct = r.headers.get("content-type") || "application/octet-stream";
        fd.append("attachments", new Blob([buf], { type: ct }), fileNameFromUrl(u));
      } catch (err: any) {
        logger.warn("Unipile email: attachment error", { u, error: err.message });
      }
    }
    resp = await fetch(url, { method: "POST", headers, body: fd });
  } else {
    resp = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: input.subject ?? "",
        body: input.htmlBody ?? "",
        to: recipients,
        ...(input.inReplyTo ? { reply_to: input.inReplyTo } : {}),
      }),
    });
  }

  const text = await resp.text();
  if (!resp.ok) throw new Error(`Unipile send ${resp.status}: ${text.slice(0, 300)}`);

  let data: any;
  try { data = JSON.parse(text); } catch { data = {}; }
  return {
    messageId: data.id || data.message_id || `unipile_${Date.now()}`,
    internetMessageId: data.internet_message_id || data.message_id || data.id || undefined,
  };
}

/**
 * Resolve whether to use Unipile for outbound email this call. Reads
 * USE_UNIPILE_EMAIL from app_settings (string truthy: "true"/"1"/"on").
 * Default false — Graph is the fallback path.
 */
export async function shouldUseUnipileEmail(): Promise<boolean> {
  try {
    const v = (await getAppSetting("USE_UNIPILE_EMAIL")).toLowerCase();
    return v === "true" || v === "1" || v === "on" || v === "yes";
  } catch {
    return false;
  }
}
