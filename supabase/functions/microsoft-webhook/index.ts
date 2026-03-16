import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken) {
    return new Response(validationToken, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const payload = await req.json();
    const notifications = payload?.value ?? [];

    for (const event of notifications) {
      const clientState = Deno.env.get('MICROSOFT_WEBHOOK_CLIENT_STATE') || 'ask-joe-ms-webhook';
      if (event.clientState && event.clientState !== clientState) continue;

      const subscriptionId = event.subscriptionId as string | undefined;
      if (!subscriptionId) continue;

      const { data: account } = await supabase
        .from('integration_accounts')
        .select('id, owner_user_id, access_token, refresh_token, token_expires_at, microsoft_user_id, microsoft_subscription_id')
        .eq('microsoft_subscription_id', subscriptionId)
        .eq('auth_provider', 'microsoft')
        .eq('is_active', true)
        .maybeSingle();

      if (!account) continue;

      const token = await getUsableAccessToken(supabase, account as any);
      const messageId = event.resourceData?.id;
      if (!messageId) continue;

      const graphRes = await fetch(
        `https://graph.microsoft.com/v1.0/users/${account.microsoft_user_id}/messages/${messageId}?$select=id,conversationId,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,replyTo,receivedDateTime,sentDateTime,parentFolderId`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!graphRes.ok) {
        console.error('Graph message fetch failed:', await graphRes.text());
        continue;
      }

      const msg = await graphRes.json();
      const sender = msg.from?.emailAddress?.address || null;
      const senderName = msg.from?.emailAddress?.name || null;
      const recipients = [
        ...(msg.toRecipients ?? []),
        ...(msg.ccRecipients ?? []),
      ]
        .map((r: any) => r?.emailAddress?.address)
        .filter(Boolean);

      const { data: existingConversation } = await supabase
        .from('conversations')
        .select('id')
        .eq('external_conversation_id', msg.conversationId)
        .eq('owner_id', account.owner_user_id)
        .maybeSingle();

      let conversationId = existingConversation?.id;
      if (!conversationId) {
        const newConversationId = crypto.randomUUID();
        const { error: convError } = await supabase.from('conversations').insert({
          id: newConversationId,
          channel: 'email',
          owner_id: account.owner_user_id,
          external_conversation_id: msg.conversationId,
          status: 'active',
          last_message_at: msg.receivedDateTime || new Date().toISOString(),
        } as any);
        if (convError) {
          console.error('Conversation insert failed:', convError);
          continue;
        }
        conversationId = newConversationId;
      }

      const { error: msgError } = await supabase.from('messages').upsert({
        conversation_id: conversationId,
        channel: 'email',
        direction: 'inbound',
        provider: 'microsoft',
        integration_account_id: account.id,
        external_message_id: msg.id,
        external_id: msg.internetMessageId,
        external_conversation_id: msg.conversationId,
        sender_address: sender,
        sender_name: senderName,
        recipient_address: recipients.join(','),
        subject: msg.subject || null,
        body: msg.body?.content || msg.bodyPreview || null,
        message_type: 'email',
        channel_type: 'outlook',
        received_at: msg.receivedDateTime || null,
        sent_at: msg.sentDateTime || null,
        raw_payload: msg,
        owner_id: account.owner_user_id,
      } as any, { onConflict: 'external_message_id' });

      if (msgError) {
        console.error('Message upsert failed:', msgError);
      }

      await supabase.from('conversations').update({
        last_message_at: msg.receivedDateTime || new Date().toISOString(),
        last_message_preview: msg.bodyPreview || msg.subject || '',
        is_read: false,
      } as any).eq('id', conversationId);

      await supabase.from('webhook_events').insert({
        provider: 'microsoft',
        event_type: event.changeType || 'mail',
        payload: event,
        received_at: new Date().toISOString(),
        processed: true,
        processed_at: new Date().toISOString(),
      } as any);
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('microsoft-webhook error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Unexpected error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function getUsableAccessToken(supabase: any, account: any): Promise<string> {
  const expiresAt = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_token && expiresAt > Date.now() + 60_000) {
    return account.access_token;
  }

  if (!account.refresh_token) throw new Error('Missing refresh token for Microsoft account');

  const tenantId = Deno.env.get('MICROSOFT_TENANT_ID') || 'common';
  const clientId = Deno.env.get('MICROSOFT_CLIENT_ID');
  const clientSecret = Deno.env.get('MICROSOFT_CLIENT_SECRET');

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId || '',
      client_secret: clientSecret || '',
      refresh_token: account.refresh_token,
      scope: 'offline_access Mail.Read Mail.ReadWrite MailboxSettings.Read',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Microsoft refresh failed: ${body}`);
  }

  const tokenJson = await response.json();
  const accessToken = tokenJson.access_token as string;
  const refreshToken = (tokenJson.refresh_token as string) || account.refresh_token;
  const expiresIn = Number(tokenJson.expires_in || 3600);
  const tokenExpiresAt = new Date(Date.now() + (expiresIn - 60) * 1000).toISOString();

  await supabase
    .from('integration_accounts')
    .update({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_expires_at: tokenExpiresAt,
    } as any)
    .eq('id', account.id);

  return accessToken;
}
