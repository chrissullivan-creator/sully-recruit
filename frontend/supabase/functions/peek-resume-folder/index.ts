import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MICROSOFT_GRAPH_CLIENT_ID = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID")!;
const MICROSOFT_GRAPH_CLIENT_SECRET = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET")!;
const MICROSOFT_GRAPH_TENANT_ID = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") || "common";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

async function getToken(account: any): Promise<string> {
  if (account.access_token && account.token_expires_at &&
      new Date(account.token_expires_at).getTime() - Date.now() > 300000)
    return account.access_token;
  const resp = await fetch(`https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MICROSOFT_GRAPH_CLIENT_ID, client_secret: MICROSOFT_GRAPH_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: account.refresh_token,
      scope: "offline_access Mail.Read Mail.Send User.Read openid profile" })
  });
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Token refresh: ${data?.error_description}`);
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const { data: account } = await supabase.from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at")
    .eq("email_address", "chris.sullivan@emeraldrecruit.com")
    .eq("auth_provider", "microsoft")
    .eq("is_active", true)
    .not("refresh_token", "is", null)
    .maybeSingle();

  if (!account) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: corsHeaders });

  const token = await getToken(account);
  const folderId = "AAMkADE5NzFjZjAwLTI4ZjMtNGUwOS1iNDQwLTgwYWZmNDI1ZTUyYQAuAAAAAAD3kCfDAtbeQrNphJt6_LKMAQA4Bft5APJVT54ruTZwWdYyAARCXO0FAAA=";

  // Fetch 10 most recent messages with full details including attachment info
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages` +
    `?$select=id,subject,receivedDateTime,hasAttachments,from,bodyPreview&$top=10&$orderby=receivedDateTime desc`;

  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await r.json();

  // For first message with or without attachments, also fetch its attachments list
  const samples = [];
  for (const msg of (data.value ?? []).slice(0, 5)) {
    const attR = await fetch(
      `https://graph.microsoft.com/v1.0/me/messages/${msg.id}/attachments?$select=id,name,contentType,size,isInline`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const attData = await attR.json();
    samples.push({
      subject: msg.subject,
      from: msg.from?.emailAddress?.address,
      received: msg.receivedDateTime,
      hasAttachments: msg.hasAttachments,
      bodyPreview: msg.bodyPreview?.slice(0, 100),
      attachments: (attData.value ?? []).map((a: any) => ({ name: a.name, type: a.contentType, size: a.size, inline: a.isInline }))
    });
  }

  return new Response(JSON.stringify({ ok: true, total_in_page: data.value?.length, samples }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
