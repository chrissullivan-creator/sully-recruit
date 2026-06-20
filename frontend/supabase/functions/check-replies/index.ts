import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID")!;
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET")!;
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";
const MICROSOFT_GRAPH_ACCOUNT_EMAILS = Deno.env.get("MICROSOFT_GRAPH_ACCOUNT_EMAILS") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function normalizeEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  return e.trim().toLowerCase() || null;
}

async function getToken(account: any): Promise<string> {
  if (account.access_token && account.token_expires_at && new Date(account.token_expires_at).getTime() - Date.now() > 300000)
    return account.access_token;
  const resp = await fetch(`https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MICROSOFT_GRAPH_CLIENT_ID, client_secret: MICROSOFT_GRAPH_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: account.refresh_token,
      scope: "offline_access Mail.Read Mail.Send User.Read openid profile" })
  });
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Token refresh: ${data?.error_description}`);
  await supabase.from("integration_accounts").update({
    access_token: data.access_token, refresh_token: data.refresh_token ?? account.refresh_token,
    token_expires_at: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const body = await req.json().catch(() => ({}));
  const daysBack = Number(body.days_back ?? 5);
  const dryRun = body.dry_run !== false; // default dry_run=true for safety
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  console.log(`[check-replies] since=${since} dry_run=${dryRun}`);

  // Load all candidate + contact emails into a lookup
  const emailToEntity = new Map<string, { type: string; id: string; name: string }>();
  const { data: candidates } = await supabase.from("candidates").select("id, email, full_name").not("email", "is", null).neq("email", "");
  for (const c of candidates ?? []) { const e = normalizeEmail(c.email); if (e) emailToEntity.set(e, { type: "candidate", id: c.id, name: c.full_name }); }
  const { data: contacts } = await supabase.from("contacts").select("id, email, full_name").not("email", "is", null).neq("email", "");
  for (const c of contacts ?? []) { const e = normalizeEmail(c.email); if (e) emailToEntity.set(e, { type: "contact", id: c.id, name: c.full_name }); }
  console.log(`[check-replies] loaded ${emailToEntity.size} known emails`);

  // Get graph accounts
  const graphEmails = new Set(MICROSOFT_GRAPH_ACCOUNT_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  const { data: accounts } = await supabase.from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at")
    .eq("is_active", true).not("refresh_token", "is", null);
  const emailAccounts = (accounts ?? []).filter((a: any) => graphEmails.has((a.email_address ?? "").toLowerCase().trim()));

  const repliers: Array<{ name: string; email: string; type: string; id: string; account: string }> = [];
  const stoppedEnrollments: Array<{ candidate_id?: string; contact_id?: string; name: string; enrollment_id: string; sequence: string }> = [];

  for (const account of emailAccounts) {
    const token = await getToken(account);
    // Fetch inbox messages received in last N days
    let url = `https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages` +
      `?$select=id,from,receivedDateTime,subject&$filter=receivedDateTime ge ${since}&$top=100&$orderby=receivedDateTime desc`;

    while (url) {
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) { console.error(`[check-replies] Graph ${resp.status}`); break; }
      const data = await resp.json();
      for (const msg of data.value ?? []) {
        const senderEmail = normalizeEmail(msg.from?.emailAddress?.address);
        if (!senderEmail) continue;
        const entity = emailToEntity.get(senderEmail);
        if (!entity) continue; // not a known candidate/contact
        // Found a reply!
        repliers.push({ name: entity.name, email: senderEmail, type: entity.type, id: entity.id, account: account.email_address });
        console.log(`[check-replies] reply from ${entity.name} (${senderEmail}) in ${account.email_address}`);
      }
      url = data["@odata.nextLink"] ?? "";
    }
  }

  // Deduplicate repliers by entity id
  const uniqueRepliers = [...new Map(repliers.map(r => [r.id, r])).values()];
  console.log(`[check-replies] found ${uniqueRepliers.length} unique repliers`);

  // For each replier, find and stop active enrollments
  for (const r of uniqueRepliers) {
    const col = r.type === "candidate" ? "candidate_id" : "contact_id";
    const { data: enrollments } = await supabase.from("sequence_enrollments")
      .select("id, sequence_id").eq(col, r.id).eq("status", "active");

    for (const e of enrollments ?? []) {
      const { data: seq } = await supabase.from("sequences").select("name, stop_on_reply").eq("id", e.sequence_id).maybeSingle();
      if (seq?.stop_on_reply === false) continue; // skip if explicitly disabled

      stoppedEnrollments.push({ [col]: r.id, name: r.name, enrollment_id: e.id, sequence: seq?.name ?? e.sequence_id } as any);

      if (!dryRun) {
        await supabase.from("sequence_enrollments").update({
          status: "stopped", stopped_reason: "reply_received_backfill", updated_at: new Date().toISOString(),
        }).eq("id", e.id);
        console.log(`[check-replies] STOPPED enrollment ${e.id} for ${r.name}`);
      }
    }
  }

  return json({ ok: true, dry_run: dryRun, days_back: daysBack, known_emails: emailToEntity.size, repliers: uniqueRepliers, stopped: stoppedEnrollments });
});
