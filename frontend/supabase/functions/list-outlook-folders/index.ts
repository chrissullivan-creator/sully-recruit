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
  await supabase.from("integration_accounts").update({
    access_token: data.access_token, refresh_token: data.refresh_token ?? account.refresh_token,
    token_expires_at: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", account.id);
  return data.access_token;
}

async function listFoldersRecursive(token: string, parentId: string | null, depth: number, results: any[]) {
  const url = parentId
    ? `https://graph.microsoft.com/v1.0/me/mailFolders/${parentId}/childFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount`
    : `https://graph.microsoft.com/v1.0/me/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount,childFolderCount`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) { console.error(`folders fetch ${resp.status}`); return; }
  const data = await resp.json();

  for (const folder of data.value ?? []) {
    results.push({
      id: folder.id,
      name: folder.displayName,
      total: folder.totalItemCount,
      unread: folder.unreadItemCount,
      depth,
    });
    if (folder.childFolderCount > 0 && depth < 3) {
      await listFoldersRecursive(token, folder.id, depth + 1, results);
    }
  }
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

  if (!account) return new Response(JSON.stringify({ error: "Chris microsoft account not found" }), { status: 404, headers: corsHeaders });

  const token = await getToken(account);
  const folders: any[] = [];
  await listFoldersRecursive(token, null, 0, folders);

  // Sort by total items desc so biggest folders are obvious
  folders.sort((a, b) => b.total - a.total);

  return new Response(JSON.stringify({ ok: true, account: account.email_address, folder_count: folders.length, folders }, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
});
