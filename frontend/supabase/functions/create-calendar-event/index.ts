// create-calendar-event — Microsoft Graph calendar event creator
//
// Called by the Send-Out UI's InterviewModal. Creates a Teams-enabled
// calendar event on the organiser's Outlook calendar via the Microsoft
// Graph Application (client-credentials) flow — same pattern as the
// existing send-message function.
//
// Request body (JSON):
//   {
//     interview_id?:      uuid,           // if set, attaches the event back to interviews row
//     send_out_id?:       uuid,           // informational, logged only
//     subject:            string,
//     start:              string (ISO),   // required
//     end?:               string (ISO),   // defaults to start + 1 hour
//     timezone?:          string,         // IANA tz, defaults to UTC
//     location?:          string,
//     meeting_link?:      string,
//     body?:              string (HTML),
//     attendees?:         [{ email, name? }, ...],
//     is_online_meeting?: boolean,        // defaults: true when no meeting_link provided
//   }
//
// Response:
//   { success: true, event_id, event_url, join_url, organizer }
//
// Auth: verify_jwt = false; the function validates the caller's bearer
// token explicitly so it can read auth.getUser() from the anon client and
// write to the interviews table via the service client.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface Attendee {
  email: string;
  name?: string;
}

interface CreateCalendarEventRequest {
  interview_id?: string;
  send_out_id?: string;
  subject: string;
  start: string;
  end?: string;
  timezone?: string;
  location?: string;
  meeting_link?: string;
  body?: string;
  attendees?: Attendee[];
  is_online_meeting?: boolean;
}

interface GraphCredentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// Microsoft Graph expects dateTime in the form YYYY-MM-DDTHH:mm:ss (no
// trailing Z, no milliseconds) paired with an IANA timeZone field.
function toGraphDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Invalid datetime: ${iso}`);
  return d.toISOString().slice(0, 19);
}

async function getGraphCredentials(serviceClient: any): Promise<GraphCredentials> {
  const { data, error } = await serviceClient
    .from('app_settings')
    .select('key, value')
    .in('key', [
      'MICROSOFT_GRAPH_CLIENT_ID',
      'MICROSOFT_GRAPH_CLIENT_SECRET',
      'MICROSOFT_GRAPH_TENANT_ID',
    ]);
  if (error) throw new Error(`Failed to read Graph credentials: ${error.message}`);
  const map = Object.fromEntries((data || []).map((r: any) => [r.key, r.value]));
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
    throw new Error(`Microsoft Graph token error: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token as string;
}

async function resolveOrganizerEmail(
  serviceClient: any,
  userId: string,
): Promise<string> {
  const { data: profile, error } = await serviceClient
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw new Error(`Failed to read profile: ${error.message}`);
  if (!profile?.email) throw new Error(`No email on profile for user ${userId}`);
  return profile.email as string;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Authenticate the caller — verify_jwt is off, so we validate the
    // bearer token explicitly here.
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return jsonResponse({ success: false, error: 'Missing Authorization header' }, 401);

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const serviceClient = createClient(supabaseUrl, serviceKey);

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ success: false, error: 'Unauthorized' }, 401);
    }

    const payload = (await req.json()) as CreateCalendarEventRequest;
    const { subject, start } = payload;
    if (!subject || !start) {
      return jsonResponse(
        { success: false, error: 'Missing required fields: subject, start' },
        400,
      );
    }

    const organizerEmail = await resolveOrganizerEmail(serviceClient, user.id);

    // Compute end datetime — default to start + 1 hour.
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) {
      return jsonResponse({ success: false, error: 'Invalid `start` datetime' }, 400);
    }
    const endDate = payload.end
      ? new Date(payload.end)
      : new Date(startDate.getTime() + 60 * 60 * 1000);
    if (isNaN(endDate.getTime())) {
      return jsonResponse({ success: false, error: 'Invalid `end` datetime' }, 400);
    }

    const timezone = payload.timezone || 'UTC';
    const hasCustomLink = !!payload.meeting_link;
    // If no meeting link was provided, default to generating a Teams meeting.
    const isOnlineMeeting = payload.is_online_meeting ?? !hasCustomLink;

    const attendees = (payload.attendees || []).map((a) => ({
      emailAddress: { address: a.email, name: a.name },
      type: 'required',
    }));

    const bodyHtml =
      payload.body ||
      (hasCustomLink
        ? `<p>Join: <a href="${payload.meeting_link}">${payload.meeting_link}</a></p>`
        : '<p>Interview scheduled via Sully Recruit.</p>');

    const event: Record<string, unknown> = {
      subject,
      start: { dateTime: toGraphDateTime(startDate.toISOString()), timeZone: timezone },
      end:   { dateTime: toGraphDateTime(endDate.toISOString()),   timeZone: timezone },
      body:  { contentType: 'HTML', content: bodyHtml },
      attendees,
    };

    if (payload.location || hasCustomLink) {
      event.location = {
        displayName: payload.location || 'Online',
        ...(hasCustomLink ? { locationUri: payload.meeting_link } : {}),
      };
    }

    if (isOnlineMeeting && !hasCustomLink) {
      // Let Graph spin up a Teams meeting for us.
      event.isOnlineMeeting = true;
      event.onlineMeetingProvider = 'teamsForBusiness';
    }

    const accessToken = await getGraphAccessToken(serviceClient);

    const graphUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(organizerEmail)}/events`;
    const resp = await fetch(graphUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // Required when writing event body/attendees in non-default timezone.
        Prefer: `outlook.timezone="${timezone}"`,
      },
      body: JSON.stringify(event),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(
        `[create-calendar-event] Graph POST /events failed for ${organizerEmail}: ${errText}`,
      );
      return jsonResponse(
        { success: false, error: `Microsoft Graph createEvent error: ${errText}` },
        502,
      );
    }

    const created = await resp.json();
    const eventId = (created.id as string) ?? null;
    const eventUrl = (created.webLink as string) ?? null;
    const joinUrl =
      ((created.onlineMeeting && created.onlineMeeting.joinUrl) as string) ?? null;

    // Persist the event IDs back to the interviews row when we have one.
    if (payload.interview_id) {
      const { error: updateError } = await serviceClient
        .from('interviews')
        .update({
          calendar_event_id: eventId,
          calendar_event_url: eventUrl,
          calendar_synced_at: new Date().toISOString(),
          meeting_link: joinUrl || payload.meeting_link || null,
          calendar_attendees: payload.attendees || [],
        })
        .eq('id', payload.interview_id);
      if (updateError) {
        console.error('[create-calendar-event] failed to attach event to interview', updateError);
      }
    }

    return jsonResponse({
      success: true,
      event_id: eventId,
      event_url: eventUrl,
      join_url: joinUrl,
      organizer: organizerEmail,
    });
  } catch (error: unknown) {
    console.error('Error in create-calendar-event function:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return jsonResponse({ success: false, error: msg }, 500);
  }
});
