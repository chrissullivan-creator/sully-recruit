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
  channel: 'email' | 'sms' | 'linkedin';
  conversation_id: string;
  candidate_id?: string;
  contact_id?: string;
  to: string; // email address, phone number, or linkedin profile url/id
  subject?: string; // for email
  body: string;
  account_id?: string; // integration account to use
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

    // Service-role client for reading secrets (app_settings), user profiles,
    // and downloading attachment bytes from storage regardless of RLS.
    const serviceClient = createClient(supabaseUrl, serviceRoleKey);

    // Get current user
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

    // Route to appropriate channel handler
    switch (channel) {
      case 'email':
        result = await sendEmail(serviceClient, user.id, to, subject, body, attachments);
        externalMessageId = result.messageId;
        break;
      case 'sms':
        // NOTE: RingCentral SMS does not support attachments in this integration.
        // They are still recorded on the message row so the UI shows them.
        result = await sendSms(supabaseClient, user.id, to, body);
        externalMessageId = result.id?.toString();
        break;
      case 'linkedin':
        // NOTE: LinkedIn attachments via Unipile are not yet wired in. The files
        // are still recorded on the message row so the UI shows them.
        result = await sendLinkedIn(supabaseClient, user.id, to, body, account_id);
        externalMessageId = result.message_id;
        break;
      default:
        throw new Error(`Unsupported channel: ${channel}`);
    }

    // Normalize attachments for DB storage — drop base64 payloads, keep
    // metadata + storage_path so the frontend can resolve signed URLs later.
    const attachmentsForDb = (attachments || []).map((a) => ({
      name: a.name,
      storage_path: a.storage_path,
      mime_type: a.mime_type || null,
      size: a.size || null,
    }));

    // Log the message in database
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

    // Update conversation's last_message_at
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

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL via Microsoft Graph — sends from the current user's mailbox.
// Credentials come from app_settings (MICROSOFT_GRAPH_*), mirroring the
// Trigger.dev task at frontend/src/trigger/lib/send-channels.ts so there is
// one canonical outbound path.
// ─────────────────────────────────────────────────────────────────────────────
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
  // Chunked encoding so big files don't blow the call stack.
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

  // Build Graph fileAttachment objects from Supabase Storage objects.
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

  // Best-effort: grab the internetMessageId from Sent Items for threading.
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

// ─────────────────────────────────────────────────────────────────────────────
// SMS via RingCentral
// ─────────────────────────────────────────────────────────────────────────────
async function sendSms(
  supabase: any,
  userId: string,
  to: string,
  message: string
): Promise<{ id: string; sender: string }> {
  // Get RingCentral config from user_integrations
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

  // Get access token using JWT
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

  // Send SMS
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

// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn via Unipile
// ─────────────────────────────────────────────────────────────────────────────
async function sendLinkedIn(
  supabase: any,
  userId: string,
  recipientId: string,
  message: string,
  accountId?: string
): Promise<{ message_id: string; sender: string }> {
  const unipileApiKey = Deno.env.get('UNIPILE_API_KEY');
  const unipileBaseUrl = Deno.env.get('UNIPILE_BASE_URL');

  if (!unipileApiKey || !unipileBaseUrl) {
    throw new Error('Unipile API not configured. Contact admin to set up LinkedIn integration.');
  }

  // Get user's Unipile account ID
  let unipileAccountId = accountId;
  
  if (!unipileAccountId) {
    const { data: accounts } = await supabase
      .from('integration_accounts')
      .select('unipile_account_id, account_label')
      .eq('owner_user_id', userId)
      .eq('provider', 'linkedin')
      .eq('is_active', true)
      .limit(1);

    if (!accounts || accounts.length === 0) {
      throw new Error('No LinkedIn account connected. Go to Settings to connect LinkedIn.');
    }
    
    unipileAccountId = accounts[0].unipile_account_id;
  }

  if (!unipileAccountId) {
    throw new Error('LinkedIn account not properly configured');
  }

  // Send message via Unipile
  const base = unipileBaseUrl.replace(/\/api\/v1\/?$/, '');
  const response = await fetch(`${base}/api/v1/messages`, {
    method: 'POST',
    headers: {
      'X-API-KEY': unipileApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      account_id: unipileAccountId,
      attendee_provider_id: recipientId,
      text: message,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error('Unipile error:', errorData);
    throw new Error(`Failed to send LinkedIn message: ${response.status}`);
  }

  const result = await response.json();
  return { 
    message_id: result.message_id || result.id || 'sent',
    sender: unipileAccountId 
  };
}
