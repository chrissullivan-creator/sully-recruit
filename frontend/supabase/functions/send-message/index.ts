import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface OutboundAttachment {
  name: string;
  storage_path: string;
  mime_type?: string | null;
  size?: number | null;
}

interface SendMessageRequest {
  channel: 'email' | 'sms' | 'linkedin' | 'linkedin_recruiter';
  conversation_id: string;
  candidate_id?: string;
  contact_id?: string;
  to: string;
  subject?: string;
  body: string;
  account_id?: string;
  attachments?: OutboundAttachment[];
}

const MESSAGE_ATTACHMENTS_BUCKET = 'message-attachments';

interface RingCentralConfig {
  client_id: string;
  client_secret: string;
  jwt_token: string;
  server_url: string;
  phone_number: string;
}

interface GraphCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    });

    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const payload: SendMessageRequest = await req.json();
    const { channel, conversation_id, candidate_id, contact_id, to, subject, body, account_id, attachments } = payload;

    if (!channel || (!body && (!attachments || attachments.length === 0))) {
      throw new Error('Missing required fields: channel, body or attachments');
    }

    let result: any;
    let externalMessageId: string | null = null;

    switch (channel) {
      case 'email':
        result = await sendEmail(serviceClient, user.id, to, subject, body, attachments);
        externalMessageId = result.messageId;
        break;
      case 'sms':
        result = await sendSms(supabaseClient, user.id, to, body);
        externalMessageId = result.id?.toString();
        break;
      case 'linkedin':
      case 'linkedin_recruiter':
        // All LinkedIn sends run on Unipile v2. A reply posts to the existing
        // chat (chat_id resolved from the conversation); new outreach starts one.
        result = await sendLinkedIn(serviceClient, user.id, {
          recipientId: to,
          message: body,
          conversationId: conversation_id,
          accountIdHint: account_id,
          subject,
          isInMail: channel === 'linkedin_recruiter',
        });
        externalMessageId = result.message_id;
        break;
      default:
        throw new Error(`Unsupported channel: ${channel}`);
    }

    const attachmentsForDb = (attachments || []).map((a) => ({
      name: a.name,
      storage_path: a.storage_path,
      mime_type: a.mime_type || null,
      size: a.size || null,
    }));

    const messageInsert: any = {
      conversation_id,
      candidate_id: candidate_id || null,
      contact_id: contact_id || null,
      channel,
      direction: 'outbound',
      subject: subject || null,
      body,
      sender_address: result.sender || null,
      recipient_address: to,
      sent_at: new Date().toISOString(),
      external_message_id: externalMessageId,
      provider: channel === 'email' ? 'microsoft_graph' : channel === 'sms' ? 'ringcentral' : 'unipile',
      owner_id: user.id,
      attachments: attachmentsForDb,
    };

    const { error: msgError } = await supabaseClient.from('messages').insert(messageInsert);
    if (msgError) {
      console.error('Failed to log message:', msgError);
    }

    const previewSource = (body || '').trim() ||
      (attachmentsForDb.length === 1
        ? `📎 ${attachmentsForDb[0].name}`
        : attachmentsForDb.length > 1
          ? `📎 ${attachmentsForDb.length} attachments`
          : '');
    await supabaseClient
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: previewSource.substring(0, 100),
        is_read: true,
      })
      .eq('id', conversation_id);

    return new Response(
      JSON.stringify({ success: true, result }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error: unknown) {
    console.error('Error in send-message function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function getGraphCredentials(serviceClient: any): Promise<GraphCredentials> {
  const { data, error } = await serviceClient
    .from('app_settings')
    .select('key, value')
    .in('key', ['MICROSOFT_GRAPH_CLIENT_ID', 'MICROSOFT_GRAPH_CLIENT_SECRET', 'MICROSOFT_GRAPH_TENANT_ID']);
  if (error) throw new Error(`Failed to read Graph credentials: ${error.message}`);
  const map = Object.fromEntries((data || []).map((row: any) => [row.key, row.value]));
  const clientId = map.MICROSOFT_GRAPH_CLIENT_ID;
  const clientSecret = map.MICROSOFT_GRAPH_CLIENT_SECRET;
  const tenantId = map.MICROSOFT_GRAPH_TENANT_ID;
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error('Microsoft Graph credentials missing in app_settings');
  }
  return { clientId, clientSecret, tenantId };
}

async function getGraphAccessToken(serviceClient: any): Promise<string> {
  const { clientId, clientSecret, tenantId } = await getGraphCredentials(serviceClient);
  const resp = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    },
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Microsoft Graph token error: ${errText}`);
  }
  const data = await resp.json();
  return data.access_token;
}

async function resolveSenderEmail(serviceClient: any, userId: string): Promise<string> {
  const { data: profile } = await serviceClient
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();
  if (profile?.email) return profile.email;
  throw new Error(`No email on profile for user ${userId}`);
}

async function downloadAttachmentAsBase64(
  serviceClient: any,
  storagePath: string
): Promise<string> {
  const { data, error } = await serviceClient.storage
    .from(MESSAGE_ATTACHMENTS_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(`Could not read attachment ${storagePath}: ${error?.message || 'unknown error'}`);
  }
  const buffer = new Uint8Array(await data.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < buffer.length; i += chunkSize) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function sendEmail(
  serviceClient: any,
  userId: string,
  to: string,
  subject: string | undefined,
  body: string,
  attachments?: OutboundAttachment[]
): Promise<{ messageId: string; sender: string }> {
  const accessToken = await getGraphAccessToken(serviceClient);
  const fromEmail = await resolveSenderEmail(serviceClient, userId);

  const graphAttachments: Array<Record<string, unknown>> = [];
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      const contentBytes = await downloadAttachmentAsBase64(serviceClient, att.storage_path);
      graphAttachments.push({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: att.name,
        contentType: att.mime_type || 'application/octet-stream',
        contentBytes,
      });
    }
  }

  const message: Record<string, unknown> = {
    subject: subject || '',
    body: { contentType: 'HTML', content: body || '' },
    toRecipients: [{ emailAddress: { address: to } }],
  };
  if (graphAttachments.length > 0) {
    message.attachments = graphAttachments;
  }

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/sendMail`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Microsoft Graph sendMail error (${fromEmail}): ${errorText}`);
  }

  let internetMessageId: string | undefined;
  try {
    const sentResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(fromEmail)}/mailFolders/SentItems/messages?$top=1&$orderby=sentDateTime desc&$select=internetMessageId&$filter=toRecipients/any(r:r/emailAddress/address eq '${to}')`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (sentResp.ok) {
      const sentData = await sentResp.json();
      internetMessageId = sentData.value?.[0]?.internetMessageId;
    }
  } catch {
    // non-fatal
  }

  const messageId = internetMessageId || `graph_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return { messageId, sender: fromEmail };
}

async function sendSms(
  supabase: any,
  userId: string,
  to: string,
  message: string
): Promise<{ id: string; sender: string }> {
  const { data: integrationData, error: configError } = await supabase
    .from('user_integrations')
    .select('config')
    .eq('user_id', userId)
    .eq('integration_type', 'ringcentral')
    .eq('is_active', true)
    .maybeSingle();

  if (configError || !integrationData) {
    throw new Error('RingCentral integration not configured. Go to Settings to set up SMS.');
  }

  const config = integrationData.config as RingCentralConfig;

  if (!config.client_id || !config.client_secret || !config.jwt_token) {
    throw new Error('RingCentral credentials are incomplete');
  }

  const tokenResponse = await fetch(`${config.server_url}/restapi/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${config.client_id}:${config.client_secret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: config.jwt_token,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Failed to get RingCentral access token: ${errorText}`);
  }

  const { access_token } = await tokenResponse.json();

  const smsResponse = await fetch(`${config.server_url}/restapi/v1.0/account/~/extension/~/sms`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${access_token}`,
    },
    body: JSON.stringify({
      from: { phoneNumber: config.phone_number },
      to: [{ phoneNumber: to }],
      text: message,
    }),
  });

  if (!smsResponse.ok) {
    const errorText = await smsResponse.text();
    throw new Error(`Failed to send SMS: ${errorText}`);
  }

  const smsResult = await smsResponse.json();
  return { id: smsResult.id, sender: config.phone_number };
}

type DbClient = ReturnType<typeof createClient>;

interface AccountRowLite {
  unipile_account_id_v2?: string | null;
  metadata?: unknown;
}

interface SendLinkedInArgs {
  recipientId: string;
  message: string;
  conversationId?: string;
  accountIdHint?: string;
  subject?: string;
  isInMail?: boolean;
}

// All LinkedIn sends run on Unipile v2 (api.unipile.com/v2), addressed by the
// account's acc_xxx id with UNIPILE_API_KEY_V2 — the same surface the rest of
// the app sends on. The v1 DSN app has no live accounts, so the old v1 send
// path (/api/v1/messages, /api/v1/chats) 404'd.
async function sendLinkedIn(
  serviceClient: DbClient,
  userId: string,
  args: SendLinkedInArgs,
): Promise<{ message_id: string; sender: string }> {
  const { recipientId, message, conversationId, accountIdHint, subject, isInMail } = args;

  const apiKeyV2 = await getAppSetting(serviceClient, 'UNIPILE_API_KEY_V2');
  const baseRaw = await getAppSetting(serviceClient, 'UNIPILE_BASE_V2_URL');
  const v2Base = (baseRaw || '').replace(/\/+$/, '') || 'https://api.unipile.com/v2';
  if (!apiKeyV2) {
    throw new Error('Unipile v2 not configured (UNIPILE_API_KEY_V2 missing in app_settings).');
  }

  // Resolve the existing chat id + owning account from the conversation. A reply
  // posts to that chat; only fresh outreach (no chat) needs to start one.
  let chatId = '';
  let integrationAccountId: string | null = null;
  let convAccountId: string | null = null;
  if (conversationId) {
    const { data: conv } = await serviceClient
      .from('conversations')
      .select('external_conversation_id, integration_account_id, account_id')
      .eq('id', conversationId)
      .maybeSingle();
    chatId = conv?.external_conversation_id || '';
    integrationAccountId = conv?.integration_account_id || null;
    convAccountId = conv?.account_id || null;
  }

  const acc = await resolveAccV2(serviceClient, integrationAccountId, accountIdHint || convAccountId);
  if (!acc) {
    throw new Error('No connected LinkedIn account (acc_xxx) found to send from.');
  }

  const headers = { 'X-API-KEY': apiKeyV2, 'Content-Type': 'application/json' };

  // Reply to an existing chat (classic OR recruiter) — the inbox case.
  if (chatId) {
    const resp = await fetch(
      `${v2Base}/${encodeURIComponent(acc)}/chats/${encodeURIComponent(chatId)}/messages/send`,
      { method: 'POST', headers, body: JSON.stringify({ text: message }) },
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Unipile v2 send error:', errText);
      throw new Error(`Failed to send LinkedIn message: ${resp.status} ${errText}`);
    }
    const result = await resp.json();
    return { message_id: normalizeMessageId(result?.message_id), sender: acc };
  }

  // No existing chat → start one. Recruiter requires subject + signature.
  if (!recipientId) {
    throw new Error('No recipient id to start a LinkedIn chat.');
  }
  const specifics = isInMail
    ? { linkedin: { recruiter: { subject: subject || 'Message', signature: await resolveSignature(serviceClient, userId) } } }
    : { linkedin: { classic: {} } };
  const resp = await fetch(
    `${v2Base}/${encodeURIComponent(acc)}/chats/send`,
    { method: 'POST', headers, body: JSON.stringify({ text: message, users_ids: [recipientId], specifics }) },
  );
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Unipile v2 start-chat error:', errText);
    throw new Error(`Failed to start LinkedIn chat: ${resp.status} ${errText}`);
  }
  const result = await resp.json();
  return { message_id: normalizeMessageId(result?.message_id), sender: acc };
}

/** Read a single app_settings value. */
async function getAppSetting(serviceClient: DbClient, key: string): Promise<string | null> {
  const { data } = await serviceClient.from('app_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}

/** Canonical acc_xxx from an integration_accounts row (column → metadata copy). */
function accV2FromRow(row: AccountRowLite | null): string | null {
  if (!row) return null;
  const direct = row.unipile_account_id_v2;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const meta = row.metadata;
  if (meta && typeof meta === 'object') {
    const v = (meta as Record<string, unknown>).unipile_account_id_v2;
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/** Resolve the v2 acc_xxx to send from: an explicit acc_xxx hint, else via the
 *  conversation's integration_account_id, else via a v1 short id, else any
 *  active LinkedIn seat. */
async function resolveAccV2(
  serviceClient: DbClient,
  integrationAccountId: string | null,
  shortOrAccId: string | null,
): Promise<string | null> {
  const hint = (shortOrAccId || '').trim();
  if (hint.startsWith('acc_')) return hint;

  if (integrationAccountId) {
    const { data } = await serviceClient
      .from('integration_accounts')
      .select('unipile_account_id_v2, metadata')
      .eq('id', integrationAccountId)
      .maybeSingle();
    const acc = accV2FromRow(data);
    if (acc) return acc;
  }

  if (hint) {
    const { data } = await serviceClient
      .from('integration_accounts')
      .select('unipile_account_id_v2, metadata')
      .eq('unipile_account_id', hint)
      .maybeSingle();
    const acc = accV2FromRow(data);
    if (acc) return acc;
  }

  const { data } = await serviceClient
    .from('integration_accounts')
    .select('unipile_account_id_v2, metadata')
    .eq('provider', 'linkedin')
    .eq('is_active', true);
  for (const row of data ?? []) {
    const acc = accV2FromRow(row);
    if (acc) return acc;
  }
  return null;
}

/** Best-effort sender signature for new Recruiter chats (reply path never uses it). */
async function resolveSignature(serviceClient: DbClient, userId: string): Promise<string> {
  const { data } = await serviceClient.from('profiles').select('email').eq('id', userId).maybeSingle();
  const email: string = data?.email || '';
  const namePart = email.split('@')[0]?.replace(/[._]+/g, ' ').trim();
  return namePart || 'Recruiter';
}

/** v2 returns message_id as string | string[] | null. */
function normalizeMessageId(mid: unknown): string {
  if (Array.isArray(mid)) return (mid[0] as string) || 'sent';
  if (typeof mid === 'string' && mid) return mid;
  return 'sent';
}
