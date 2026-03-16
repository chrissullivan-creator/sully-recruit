import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

interface SendMessageRequest {
  channel: 'email' | 'sms' | 'linkedin';
  conversation_id: string;
  candidate_id?: string;
  contact_id?: string;
  to: string; // email address, phone number, or linkedin profile url/id
  subject?: string; // for email
  body: string;
  account_id?: string; // integration account to use
}

interface RingCentralConfig {
  client_id: string;
  client_secret: string;
  jwt_token: string;
  server_url: string;
  phone_number: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: req.headers.get('Authorization')! },
      },
    });

    // Get current user
    const { data: { user }, error: userError } = await supabaseClient.auth.getUser();
    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    const payload: SendMessageRequest = await req.json();
    const { channel, conversation_id, candidate_id, contact_id, to, subject, body, account_id } = payload;

    if (!channel || !body) {
      throw new Error('Missing required fields: channel, body');
    }

    let result: any;
    let externalMessageId: string | null = null;

    // Route to appropriate channel handler
    switch (channel) {
      case 'email':
        result = await sendEmail(supabaseClient, user.id, to, subject, body);
        externalMessageId = result.messageId;
        break;
      case 'sms':
        result = await sendSms(supabaseClient, user.id, to, body);
        externalMessageId = result.id?.toString();
        break;
      case 'linkedin':
        result = await sendLinkedIn(supabaseClient, user.id, to, body, account_id);
        externalMessageId = result.message_id;
        break;
      default:
        throw new Error(`Unsupported channel: ${channel}`);
    }

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
      provider: channel === 'email' ? 'microsoft' : channel === 'sms' ? 'ringcentral' : 'unipile',
      owner_id: user.id,
    };

    const { error: msgError } = await supabaseClient.from('messages').insert(messageInsert);
    if (msgError) {
      console.error('Failed to log message:', msgError);
    }

    // Update conversation's last_message_at
    await supabaseClient
      .from('conversations')
      .update({
        last_message_at: new Date().toISOString(),
        last_message_preview: body.substring(0, 100),
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
// EMAIL via Microsoft Graph (Outlook only)
// ─────────────────────────────────────────────────────────────────────────────
async function sendEmail(
  supabase: any,
  userId: string,
  to: string,
  subject: string | undefined,
  body: string
): Promise<{ messageId: string; sender: string }> {
  const { data: integrationData } = await supabase
    .from('user_integrations')
    .select('config')
    .eq('user_id', userId)
    .eq('integration_type', 'outlook')
    .eq('is_active', true)
    .maybeSingle();

  if (!integrationData?.config?.access_token) {
    throw new Error('No valid Microsoft account exists. Connect Outlook in Settings.');
  }

  const accessToken = integrationData.config.access_token;
  const fromEmail = integrationData.config.email || integrationData.config.user_principal_name || 'microsoft';

  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject: subject || 'No Subject',
        body: { contentType: 'HTML', content: body.replace(/\n/g, '<br>') },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`send failure from Graph: ${errorText}`);
  }

  return { messageId: crypto.randomUUID(), sender: fromEmail };
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
  const response = await fetch(`${unipileBaseUrl}/api/v1/messages`, {
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
