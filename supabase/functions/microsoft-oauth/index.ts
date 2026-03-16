import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

const GRAPH_SCOPE = [
  'offline_access',
  'openid',
  'profile',
  'email',
  'Mail.Read',
  'Mail.ReadWrite',
  'MailboxSettings.Read',
].join(' ');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const adminClient = createClient(supabaseUrl, serviceKey);

    const url = new URL(req.url);
    const action = url.pathname.split('/').pop();

    if (action === 'callback') {
      return await handleCallback(url, adminClient);
    }

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return json({ error: 'Unauthorized' }, 401);

    if (action === 'authorize') {
      const tenantId = Deno.env.get('MICROSOFT_TENANT_ID') || 'common';
      const clientId = Deno.env.get('MICROSOFT_CLIENT_ID');
      const redirectUri = Deno.env.get('MICROSOFT_REDIRECT_URI') || `${supabaseUrl}/functions/v1/microsoft-oauth/callback`;
      if (!clientId) return json({ error: 'MICROSOFT_CLIENT_ID is not configured' }, 500);

      const state = btoa(JSON.stringify({ user_id: user.id, nonce: crypto.randomUUID(), ts: Date.now() }));
      const authUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_mode', 'query');
      authUrl.searchParams.set('scope', GRAPH_SCOPE);
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('prompt', 'select_account');

      return json({ url: authUrl.toString() });
    }

    if (action === 'status') {
      const { data: account } = await adminClient
        .from('integration_accounts')
        .select('id, external_account_id, account_label, is_active, token_expires_at, microsoft_subscription_id, microsoft_subscription_expires_at, microsoft_user_id')
        .eq('owner_user_id', user.id)
        .eq('auth_provider', 'microsoft')
        .eq('provider', 'email')
        .eq('is_active', true)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return json({
        connected: Boolean(account),
        email_address: account?.external_account_id ?? undefined,
        display_name: account?.account_label ?? undefined,
        token_expires_at: account?.token_expires_at ?? null,
        microsoft_user_id: account?.microsoft_user_id ?? null,
        microsoft_subscription_id: account?.microsoft_subscription_id ?? null,
        microsoft_subscription_expires_at: account?.microsoft_subscription_expires_at ?? null,
      });
    }

    if (action === 'disconnect' && req.method === 'POST') {
      await adminClient
        .from('integration_accounts')
        .update({
          is_active: false,
          microsoft_subscription_id: null,
          microsoft_subscription_expires_at: null,
        } as any)
        .eq('owner_user_id', user.id)
        .eq('auth_provider', 'microsoft');

      return json({ success: true });
    }

    return json({ error: 'Not found' }, 404);
  } catch (error: any) {
    console.error('microsoft-oauth error:', error);
    return json({ error: error.message || 'Unexpected error' }, 500);
  }
});

async function handleCallback(url: URL, adminClient: any): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID') || 'common';
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET');
  const redirectUri = Deno.env.get('MICROSOFT_REDIRECT_URI') || `${supabaseUrl}/functions/v1/microsoft-oauth/callback`;
  const appUrl = Deno.env.get('SITE_URL') || 'http://localhost:5173';

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError || !code || !state || !clientId || !clientSecret) {
    return Response.redirect(`${appUrl}/settings?ms_error=${encodeURIComponent(oauthError || 'missing_params')}`, 302);
  }

  let statePayload: { user_id: string };
  try {
    statePayload = JSON.parse(atob(state));
  } catch {
    return Response.redirect(`${appUrl}/settings?ms_error=invalid_state`, 302);
  }

  const tokenResp = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: GRAPH_SCOPE,
    }),
  });

  if (!tokenResp.ok) {
    const body = await tokenResp.text();
    console.error('Token exchange failed:', body);
    return Response.redirect(`${appUrl}/settings?ms_error=token_exchange_failed`, 302);
  }

  const tokenJson = await tokenResp.json();
  const accessToken = tokenJson.access_token as string;
  const refreshToken = tokenJson.refresh_token as string;
  const expiresIn = Number(tokenJson.expires_in || 3600);
  const tokenExpiresAt = new Date(Date.now() + (expiresIn - 60) * 1000).toISOString();

  const meResp = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!meResp.ok) {
    const body = await meResp.text();
    console.error('Failed to fetch /me:', body);
    return Response.redirect(`${appUrl}/settings?ms_error=profile_fetch_failed`, 302);
  }

  const me = await meResp.json();
  const email = me.mail || me.userPrincipalName;

  const notificationUrl = Deno.env.get('MICROSOFT_WEBHOOK_URL') || `${supabaseUrl}/functions/v1/microsoft-webhook`;
  const subResp = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      changeType: 'created,updated',
      notificationUrl,
      resource: '/me/mailFolders(\'Inbox\')/messages',
      expirationDateTime: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      clientState: Deno.env.get('MICROSOFT_WEBHOOK_CLIENT_STATE') || 'ask-joe-ms-webhook',
    }),
  });

  if (!subResp.ok) {
    const body = await subResp.text();
    console.error('Subscription create failed:', body);
    return Response.redirect(`${appUrl}/settings?ms_error=subscription_create_failed`, 302);
  }

  const subscription = await subResp.json();

  const upsertPayload = {
    owner_user_id: statePayload.user_id,
    provider: 'email',
    account_type: 'inbox',
    auth_provider: 'microsoft',
    external_account_id: email,
    account_label: me.displayName || email,
    is_active: true,
    access_token: accessToken,
    refresh_token: refreshToken,
    token_expires_at: tokenExpiresAt,
    microsoft_user_id: me.id,
    microsoft_subscription_id: subscription.id,
    microsoft_subscription_expires_at: subscription.expirationDateTime,
  };

  const { error } = await adminClient
    .from('integration_accounts')
    .upsert(upsertPayload as any, { onConflict: 'owner_user_id,auth_provider,external_account_id' });

  if (error) {
    console.error('Failed to save Microsoft integration:', error);
    return Response.redirect(`${appUrl}/settings?ms_error=integration_save_failed`, 302);
  }

  return Response.redirect(`${appUrl}/settings?ms_connected=1`, 302);
}

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
