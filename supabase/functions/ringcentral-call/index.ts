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

interface InitiateCallRequest {
  to: string;
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

    const { to, entity_id, entity_type } = await req.json() as InitiateCallRequest;

    if (!to) {
      throw new Error('Missing required field: to');
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

    // Step 2: Initiate RingOut call
    const callResponse = await fetch(`${config.server_url}/restapi/v1.0/account/~/extension/~/ring-out`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({
        from: { phoneNumber: config.phone_number },
        to: { phoneNumber: to },
        playPrompt: false,
      }),
    });

    if (!callResponse.ok) {
      const errorText = await callResponse.text();
      throw new Error(`Failed to initiate call: ${errorText}`);
    }

    const callResult = await callResponse.json();

    // Step 3: Log the call in our database
    const callLogInsert: any = {
      direction: 'outbound',
      phone_number: to,
      status: 'in_progress',
      started_at: new Date().toISOString(),
      external_call_id: callResult.id?.toString(),
      owner_id: user.id,
    };

    if (entity_id && entity_type) {
      callLogInsert.linked_entity_id = entity_id;
      callLogInsert.linked_entity_type = entity_type;
    }

    const { data: callLog, error: callLogError } = await supabaseClient
      .from('call_logs')
      .insert(callLogInsert)
      .select()
      .single();

    if (callLogError) {
      console.error('Failed to create call log:', callLogError);
    }

    return new Response(
      JSON.stringify({
        success: true,
        call: callResult,
        call_log_id: callLog?.id,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
  } catch (error: unknown) {
    console.error('Error in ringcentral-call function:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ success: false, error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
