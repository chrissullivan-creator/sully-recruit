import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type OutlookConfig = {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  tenant_id?: string;
  subscription_id?: string;
  webhook_url?: string;
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      throw new Error('Missing Supabase environment variables');
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userData, error: userError } = await userClient.auth.getUser();
    if (userError || !userData?.user) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const userId = userData.user.id;

    const { data: outlookIntegration, error: outlookError } = await userClient
      .from('user_integrations')
      .select('id, is_active, config, updated_at')
      .eq('integration_type', 'outlook')
      .maybeSingle();

    if (outlookError) {
      throw outlookError;
    }

    const cfg = (outlookIntegration?.config ?? {}) as OutlookConfig;

    const { data: integrationAccounts, error: accountsError } = await adminClient
      .from('integration_accounts')
      .select('id, provider, account_type, external_account_id, is_active, updated_at')
      .eq('owner_user_id', userId)
      .in('provider', ['microsoft', 'outlook']);

    if (accountsError) {
      throw accountsError;
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: inboundMessages, error: messageError } = await adminClient
      .from('messages')
      .select('id, provider, external_message_id, sender_address, recipient_address, received_at, created_at')
      .eq('owner_id', userId)
      .eq('channel', 'email')
      .eq('direction', 'inbound')
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(2000);

    if (messageError) {
      throw messageError;
    }

    const providerBackedInbound = (inboundMessages ?? []).filter((m) => {
      const hasProvider = !!m.provider;
      const hasExternalId = !!m.external_message_id;
      const hasAddresses = !!m.sender_address && !!m.recipient_address;
      return hasProvider && hasExternalId && hasAddresses;
    });

    const { data: webhookEvents, error: webhookError } = await adminClient
      .from('webhook_events')
      .select('id, provider, event_type, received_at, processed, error')
      .in('provider', ['microsoft', 'outlook', 'graph'])
      .gte('received_at', sevenDaysAgo)
      .order('received_at', { ascending: false })
      .limit(2000);

    if (webhookError) {
      throw webhookError;
    }

    const msWebhookEvents = webhookEvents ?? [];
    const processedWebhookCount = msWebhookEvents.filter((e) => e.processed).length;
    const erroredWebhookCount = msWebhookEvents.filter((e) => !!e.error).length;

    return json({
      ok: true,
      user_id: userId,
      checks: {
        microsoft_oauth: {
          exists: !!outlookIntegration,
          active: !!outlookIntegration?.is_active,
          has_access_token: !!cfg.access_token,
          has_refresh_token: !!cfg.refresh_token,
          access_token_expires_at: cfg.expires_at ?? null,
          integration_updated_at: outlookIntegration?.updated_at ?? null,
        },
        microsoft_integration_accounts: {
          count: integrationAccounts?.length ?? 0,
          active_count: (integrationAccounts ?? []).filter((a) => a.is_active).length,
        },
        inbound_email_messages_30d: {
          total_inbound_rows: inboundMessages?.length ?? 0,
          provider_backed_rows: providerBackedInbound.length,
          missing_metadata_rows: (inboundMessages?.length ?? 0) - providerBackedInbound.length,
          looks_like_test_data_only:
            (inboundMessages?.length ?? 0) > 0 && providerBackedInbound.length === 0,
          latest_provider_backed_received_at: providerBackedInbound[0]?.received_at ?? null,
        },
        microsoft_webhooks_7d: {
          total_events: msWebhookEvents.length,
          processed_events: processedWebhookCount,
          errored_events: erroredWebhookCount,
          latest_event_at: msWebhookEvents[0]?.received_at ?? null,
        },
      },
    });
  } catch (error) {
    console.error('inbound-email-health error', error);
    return json(
      { ok: false, error: error instanceof Error ? error.message : 'Unknown error' },
      500,
    );
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

