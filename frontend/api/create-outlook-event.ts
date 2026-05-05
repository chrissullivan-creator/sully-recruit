import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/create-outlook-event
 *
 * Creates an Outlook calendar event on the authenticated user's calendar via
 * Microsoft Graph (client_credentials flow against app_settings creds), then
 * mirrors the event as a `tasks` row (task_type='meeting') so the in-app
 * calendar surfaces pick it up immediately. Optionally links the event to a
 * candidate or contact via `meeting_attendees` + `task_links`.
 *
 * Body:
 *   subject:        string (required)
 *   start_iso:      string (required, ISO datetime — UTC if no offset)
 *   end_iso:        string (required, ISO datetime)
 *   description?:   string
 *   location?:      string
 *   online?:        boolean (defaults true — adds Teams meeting)
 *   attendee_email?:string (the candidate/contact email to invite)
 *   attendee_name?: string
 *   entity_id?:     string (candidate/contact id to link)
 *   entity_type?:   'candidate' | 'contact'
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
  if (!user.email) return res.status(400).json({ error: "User has no email — can't create on their calendar" });

  const {
    subject, start_iso, end_iso,
    description = "", location = "", online = true,
    attendee_email = null, attendee_name = null,
    entity_id = null, entity_type = null,
  } = req.body || {};

  if (!subject || !start_iso || !end_iso) {
    return res.status(400).json({ error: "subject, start_iso, end_iso are required" });
  }

  try {
    // 1) Pull Graph creds from app_settings
    const { data: settings } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", [
        "MICROSOFT_GRAPH_CLIENT_ID",
        "MICROSOFT_GRAPH_CLIENT_SECRET",
        "MICROSOFT_GRAPH_TENANT_ID",
      ]);
    const settingsMap = new Map((settings ?? []).map((s: any) => [s.key, s.value]));
    const clientId = settingsMap.get("MICROSOFT_GRAPH_CLIENT_ID");
    const clientSecret = settingsMap.get("MICROSOFT_GRAPH_CLIENT_SECRET");
    const tenantId = settingsMap.get("MICROSOFT_GRAPH_TENANT_ID");
    if (!clientId || !clientSecret || !tenantId) {
      return res.status(500).json({ error: "Microsoft Graph credentials missing in app_settings" });
    }

    // 2) Get app-only access token
    const tokResp = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: "https://graph.microsoft.com/.default",
          grant_type: "client_credentials",
        }),
      },
    );
    if (!tokResp.ok) {
      const err = await tokResp.text();
      return res.status(502).json({ error: `Microsoft token error: ${err}` });
    }
    const { access_token } = await tokResp.json();

    // 3) POST event to Graph
    const eventBody: Record<string, any> = {
      subject,
      body: { contentType: "HTML", content: description },
      start: { dateTime: start_iso, timeZone: "UTC" },
      end: { dateTime: end_iso, timeZone: "UTC" },
      isOnlineMeeting: !!online,
      onlineMeetingProvider: online ? "teamsForBusiness" : undefined,
    };
    if (location) {
      eventBody.location = { displayName: location };
    }
    if (attendee_email) {
      eventBody.attendees = [{
        emailAddress: { address: attendee_email, name: attendee_name || attendee_email },
        type: "required",
      }];
    }

    const ownerEmailEnc = encodeURIComponent(user.email);
    const graphResp = await fetch(
      `https://graph.microsoft.com/v1.0/users/${ownerEmailEnc}/events`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(eventBody),
      },
    );
    if (!graphResp.ok) {
      const err = await graphResp.text();
      return res.status(502).json({ error: `Microsoft Graph error: ${err}` });
    }
    const event = await graphResp.json();
    const externalId: string = event.id || event.iCalUId;
    const onlineUrl: string = event.onlineMeeting?.joinUrl || "";

    // 4) Mirror as task (task_type='meeting') so in-app calendar updates now
    //    instead of waiting for the next sync job.
    const dateOnly = String(start_iso).slice(0, 10);
    const { data: taskRow } = await supabase
      .from("tasks")
      .insert({
        title: subject,
        description: description.slice(0, 500) || null,
        priority: "medium",
        due_date: dateOnly,
        start_time: start_iso,
        end_time: end_iso,
        timezone: "UTC",
        task_type: "meeting",
        location: location || null,
        meeting_url: onlineUrl || null,
        assigned_to: user.id,
        created_by: user.id,
        external_id: externalId,
      } as any)
      .select("id")
      .single();

    // 5) Link to candidate/contact if provided
    if (taskRow?.id && entity_id && entity_type) {
      await supabase.from("meeting_attendees").insert({
        task_id: taskRow.id,
        entity_type,
        entity_id,
      } as any);
      await supabase.from("task_links").insert({
        task_id: taskRow.id,
        entity_type,
        entity_id,
      } as any);
    }

    return res.status(200).json({
      event_id: externalId,
      task_id: taskRow?.id ?? null,
      online_meeting_url: onlineUrl,
      web_link: event.webLink || null,
    });
  } catch (err: any) {
    console.error("create-outlook-event error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
