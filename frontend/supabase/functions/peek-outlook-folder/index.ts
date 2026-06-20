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
  if (account.access_token && account.token_expires_at && new Date(account.token_expires_at).getTime() - Date.now() > 300000)
    return account.access_token;
  const resp = await fetch(`https://login.microsoftonline.com/${MICROSOFT_GRAPH_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: MICROSOFT_GRAPH_CLIENT_ID, client_secret: MICROSOFT_GRAPH_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: account.refresh_token,
      scope: "offline_access Mail.Read Mail.Send User.Read openid profile" })
  });
  const data: any = await resp.json();
  if (!resp.ok) throw new Error(`Token: ${data?.error_description}`);
  await supabase.from("integration_accounts").update({ access_token: data.access_token, refresh_token: data.refresh_token ?? account.refresh_token, token_expires_at: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(), updated_at: new Date().toISOString() }).eq("id", account.id);
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const FOLDER_ID = "AAMkADE5NzFjZjAwLTI4ZjMtNGUwOS1iNDQwLTgwYWZmNDI1ZTUyYQAuAAAAAAD3kCfDAtbeQrNphJt6_LKMAQA4Bft5APJVT54ruTZwWdYyAARCXO0FAAA=";

  const { data: account } = await supabase.from("integration_accounts")
    .select("id, email_address, access_token, refresh_token, token_expires_at")
    .eq("email_address", "chris.sullivan@emeraldrecruit.com")
    .eq("auth_provider", "microsoft").eq("is_active", true)
    .not("refresh_token", "is", null).maybeSingle();
  if (!account) return new Response(JSON.stringify({ error: "no account" }), { status: 404, headers: corsHeaders });

  const token = await getToken(account);

  // Grab 3 sample emails from the folder with full body
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/${encodeURIComponent(FOLDER_ID)}/messages?$select=id,subject,from,receivedDateTime,hasAttachments,body,bodyPreview&$top=3&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await r.json();

  // For each message also check attachments
  const samples = [];
  for (const msg of data.value ?? []) {
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
      bodyPreview: msg.bodyPreview?.slice(0, 200),
      bodyContentType: msg.body?.contentType,
      attachments: (attData.value ?? []).map((a: any) => ({ name: a.name, type: a.contentType, size: a.size, isInline: a.isInline }))
    });
  }

  return new Response(JSON.stringify({ samples }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
