import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface RingCentralConfig {
  client_id: string;
  client_secret: string;
  jwt_token: string;
  server_url: string;
  phone_number: string;
}

interface SendSmsRequest {
  to: string;
  message: string;
  entity_id?: string;
  entity_type?: string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { Authorization: req.headers.get('Authorization')! },
        },
      }
    );

    // Get current user
    const {
      data: { user },
      error: userError,
    } = await supabaseClient.auth.getUser();

    if (userError || !user) {
      throw new Error('Unauthorized');
    }

    // Get RingCentral config from user_integrations
    const { data: integrationData, error: configError } = await supabaseClient
      .from('user_integrations')
      .select('config')
      .eq('user_id', user.id)
      .eq('integration_type', 'ringcentral')
      .eq('is_active', true)
      .maybeSingle();

    if (configError || !integrationData) {
      throw new Error('RingCentral integration not configured');
    }

    const config = integrationData.config as unknown as RingCentralConfig;

    if (!config.client_id || !config.client_secret || !config.jwt_token) {
      throw new Error('RingCentral credentials are incomplete');
    }

    const { to, message, entity_id, entity_type } = await req.json() as SendSmsRequest;

    if (!to || !message) {
      throw new Error('Missing required fields: to and message');
    }

    // Step 1: Get access token using JWT
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

    // Step 2: Send SMS
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

    // Step 3: Log the message in our database
    if (entity_id && entity_type) {
      // Find or create a conversation
      let conversationId: string;
      
      const { data: existingConv } = await supabaseClient
        .from('conversations')
        .select('id')
        .eq(entity_type === 'candidate' ? 'candidate_id' : 'contact_id', entity_id)
        .eq('channel', 'sms')
        .maybeSingle();

      if (existingConv) {
        conversationId = existingConv.id;
      } else {
        const convInsert = entity_type === 'candidate'
          ? { candidate_id: entity_id, channel: 'sms' }
          : { contact_id: entity_id, candidate_id: null, channel: 'sms' };

        const { data: newConv, error: convError } = await supabaseClient
          .from('conversations')
          .insert(convInsert)
          .select('id')
          .single();

        if (convError || !newConv) {
          console.error('Failed to create conversation:', convError);
          conversationId = '';
        } else {
          conversationId = newConv.id;
        }
      }

      // Insert message record
      if (conversationId) {
        const messageInsert = {
          conversation_id: conversationId,
          candidate_id: entity_type === 'candidate' ? entity_id : null,
          contact_id: entity_type === 'contact' ? entity_id : null,
          channel: 'sms',
          direction: 'outbound',
          body: message,
          sender_address: config.phone_number,
          recipient_address: to,
          sent_at: new Date().toISOString(),
          external_message_id: smsResult.id?.toString(),
          provider: 'ringcentral',
        };

        await supabaseClient.from('messages').insert(messageInsert);
      }
    }

    return new Response(JSON.stringify({ success: true, result: smsResult }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('Error in ringcentral-sms function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
