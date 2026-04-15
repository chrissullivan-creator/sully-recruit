import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/**
 * microsoft-oauth
 *
 * Handles Microsoft OAuth2 authorization code flow for per-user calendar sync.
 * Routes:
 *   GET  /authorize  — redirect user to Microsoft login
 *   GET  /callback   — exchange code for tokens, store in user_integrations
 *   GET  /status     — check if current user has a connected Microsoft account
 *   POST /disconnect — remove the user's Microsoft connection
 *
 * Uses MICROSOFT_GRAPH_CLIENT_ID / SECRET / TENANT_ID from Supabase secrets.
 * Tokens are stored in user_integrations.config (integration_type = 'microsoft_oauth').
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Route: /functions/v1/microsoft-oauth/<action>
  const pathParts = url.pathname.split("/").filter(Boolean);
  const action = pathParts[pathParts.length - 1]; // authorize | callback | status | disconnect

  const clientId = Deno.env.get("MICROSOFT_GRAPH_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("MICROSOFT_GRAPH_CLIENT_SECRET") ?? "";
  const tenantId = Deno.env.get("MICROSOFT_GRAPH_TENANT_ID") ?? "common";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!clientId || !clientSecret) {
    return jsonResponse({ error: "Microsoft OAuth not configured" }, 500);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // The redirect URI must match what's registered in the Azure app
  const redirectUri = `${supabaseUrl}/functions/v1/microsoft-oauth/callback`;

  try {
    switch (action) {
      case "authorize":
        return handleAuthorize(req, supabase, clientId, tenantId, redirectUri);
      case "callback":
        return handleCallback(req, url, supabase, clientId, clientSecret, tenantId, redirectUri);
      case "status":
        return handleStatus(req, supabase);
      case "disconnect":
        return handleDisconnect(req, supabase);
      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 404);
    }
  } catch (err: any) {
    console.error("microsoft-oauth error:", err);
    return jsonResponse({ error: err.message }, 500);
  }
});

// ─── AUTHORIZE ────────────────────────────────────────────────────────────────

async function handleAuthorize(
  req: Request,
  supabase: any,
  clientId: string,
  tenantId: string,
  redirectUri: string,
) {
  const userId = await getUserId(req, supabase);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  // State parameter encodes the user ID so callback can associate the tokens
  const state = btoa(JSON.stringify({ uid: userId }));

  const scopes = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "Calendars.Read",
    "Calendars.ReadWrite",
    "Mail.Read",
    "Mail.Send",
    "User.Read",
  ].join(" ");

  const authUrl =
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?` +
    new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      response_mode: "query",
      scope: scopes,
      state,
      prompt: "consent",
    }).toString();

  return jsonResponse({ url: authUrl });
}

// ─── CALLBACK ─────────────────────────────────────────────────────────────────

async function handleCallback(
  req: Request,
  url: URL,
  supabase: any,
  clientId: string,
  clientSecret: string,
  tenantId: string,
  redirectUri: string,
) {
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Determine frontend URL for redirects
  const frontendUrl = Deno.env.get("FRONTEND_URL") || "https://app.sullyrecruit.com";

  if (error) {
    return Response.redirect(
      `${frontendUrl}/settings?ms_error=${encodeURIComponent(error)}`,
      302,
    );
  }

  if (!code || !stateParam) {
    return Response.redirect(
      `${frontendUrl}/settings?ms_error=missing_params`,
      302,
    );
  }

  // Decode state to get user ID
  let userId: string;
  try {
    const parsed = JSON.parse(atob(stateParam));
    userId = parsed.uid;
  } catch {
    return Response.redirect(
      `${frontendUrl}/settings?ms_error=invalid_state`,
      302,
    );
  }

  // Exchange code for tokens
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const tokenResp = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: "openid profile email offline_access Calendars.Read Calendars.ReadWrite Mail.Read Mail.Send User.Read",
    }),
  });

  if (!tokenResp.ok) {
    const errBody = await tokenResp.text();
    console.error("Token exchange failed:", errBody);
    return Response.redirect(
      `${frontendUrl}/settings?ms_error=token_exchange_failed`,
      302,
    );
  }

  const tokens = await tokenResp.json();
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const expiresIn = tokens.expires_in || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Fetch user profile from Graph to get display name + email
  let displayName = "";
  let emailAddress = "";
  try {
    const meResp = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (meResp.ok) {
      const me = await meResp.json();
      displayName = me.displayName || "";
      emailAddress = me.mail || me.userPrincipalName || "";
    }
  } catch {
    // Non-fatal — we still have the tokens
  }

  // Store tokens in user_integrations
  const config = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    display_name: displayName,
    email_address: emailAddress,
    connected_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await supabase
    .from("user_integrations")
    .upsert(
      {
        user_id: userId,
        integration_type: "microsoft_oauth",
        config,
        is_active: true,
      },
      { onConflict: "user_id,integration_type" },
    );

  if (upsertErr) {
    console.error("Failed to store tokens:", upsertErr);
    return Response.redirect(
      `${frontendUrl}/settings?ms_error=storage_failed`,
      302,
    );
  }

  // Also upsert an integration_accounts row so sync-outlook-events can find it
  await supabase.from("integration_accounts").upsert(
    {
      provider: "microsoft",
      account_type: "oauth",
      external_account_id: emailAddress,
      account_label: displayName || emailAddress,
      owner_user_id: userId,
      is_active: true,
    } as any,
    { onConflict: "provider,owner_user_id", ignoreDuplicates: false },
  );

  return Response.redirect(`${frontendUrl}/settings?ms_connected=1`, 302);
}

// ─── STATUS ───────────────────────────────────────────────────────────────────

async function handleStatus(req: Request, supabase: any) {
  const userId = await getUserId(req, supabase);
  if (!userId) return jsonResponse({ connected: false, loading: false });

  const { data } = await supabase
    .from("user_integrations")
    .select("config, is_active")
    .eq("user_id", userId)
    .eq("integration_type", "microsoft_oauth")
    .maybeSingle();

  if (!data || !data.is_active) {
    return jsonResponse({ connected: false, loading: false });
  }

  const config = data.config || {};
  return jsonResponse({
    connected: true,
    display_name: config.display_name || "",
    email_address: config.email_address || "",
    loading: false,
  });
}

// ─── DISCONNECT ───────────────────────────────────────────────────────────────

async function handleDisconnect(req: Request, supabase: any) {
  const userId = await getUserId(req, supabase);
  if (!userId) return jsonResponse({ error: "Unauthorized" }, 401);

  // Deactivate user_integrations row
  await supabase
    .from("user_integrations")
    .update({ is_active: false, config: {} })
    .eq("user_id", userId)
    .eq("integration_type", "microsoft_oauth");

  // Deactivate integration_accounts row
  await supabase
    .from("integration_accounts")
    .update({ is_active: false } as any)
    .eq("provider", "microsoft")
    .eq("owner_user_id", userId);

  return jsonResponse({ success: true });
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function getUserId(req: Request, supabase: any): Promise<string | null> {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return null;

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
