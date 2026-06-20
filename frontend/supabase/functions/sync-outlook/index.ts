import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { user_id } = await req.json();

  if (!user_id) {
    return new Response(JSON.stringify({ error: "user_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: conn } = await supabase
      .from("calendar_connections")
      .select("*")
      .eq("user_id", user_id)
      .eq("provider", "microsoft")
      .eq("enabled", true)
      .single();

    if (!conn) {
      return new Response(JSON.stringify({ error: "No calendar connection found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Refresh token
    const MICROSOFT_CLIENT_ID = Deno.env.get("MICROSOFT_CLIENT_ID") ?? "";
    const MICROSOFT_CLIENT_SECRET = Deno.env.get("MICROSOFT_CLIENT_SECRET") ?? "";

    const tokenRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: conn.refresh_token,
        client_id: MICROSOFT_CLIENT_ID,
        client_secret: MICROSOFT_CLIENT_SECRET,
        scope: "Calendars.Read User.Read offline_access",
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error("[sync-outlook] Token refresh failed:", tokenData);
      return new Response(JSON.stringify({ error: "Token refresh failed", details: tokenData.error_description }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const access_token = tokenData.access_token;

    // Save refreshed tokens
    if (tokenData.refresh_token) {
      await supabase.from("calendar_connections").update({
        access_token,
        refresh_token: tokenData.refresh_token,
      }).eq("id", conn.id);
    }

    // Fetch events: 7 days back, 30 days forward
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const thirtyDaysOut = new Date(Date.now() + 30 * 86400000).toISOString();

    const eventsRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${sevenDaysAgo}&endDateTime=${thirtyDaysOut}&$select=id,subject,bodyPreview,start,end,attendees,location,onlineMeeting&$top=100`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    if (!eventsRes.ok) {
      const errText = await eventsRes.text();
      console.error("[sync-outlook] Graph API error:", errText);
      return new Response(JSON.stringify({ error: `Graph API ${eventsRes.status}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { value: events = [] } = await eventsRes.json();
    let matched = 0;
    let noMatch = 0;
    let skipped = 0;

    for (const event of events) {
      // Upsert event
      const { data: calEvent, error: upsertErr } = await supabase
        .from("calendar_events")
        .upsert({
          external_id: event.id,
          user_id,
          title: event.subject,
          description: event.bodyPreview,
          start_at: event.start?.dateTime ? new Date(event.start.dateTime + "Z").toISOString() : null,
          end_at: event.end?.dateTime ? new Date(event.end.dateTime + "Z").toISOString() : null,
          attendees: event.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [],
          location: event.location?.displayName || null,
          meeting_url: event.onlineMeeting?.joinUrl || null,
          raw_json: event,
          synced_at: new Date().toISOString(),
        }, { onConflict: "external_id" })
        .select()
        .single();

      if (upsertErr || !calEvent) {
        console.error("[sync-outlook] Upsert error:", upsertErr?.message);
        continue;
      }

      // Skip if already matched/skipped
      if (calEvent.match_status === "matched" || calEvent.match_status === "skipped") {
        skipped++;
        continue;
      }

      // Match attendees against candidates + contacts
      const emails = event.attendees?.map((a: any) => a.emailAddress?.address).filter(Boolean) || [];
      if (emails.length === 0) {
        await supabase.from("calendar_events").update({ match_status: "no_match" }).eq("id", calEvent.id);
        noMatch++;
        continue;
      }

      const [{ data: candidates }, { data: contacts }] = await Promise.all([
        supabase.from("candidates").select("id, full_name, email").in("email", emails),
        supabase.from("contacts").select("id, full_name, email").in("email", emails),
      ]);

      // Match jobs by title keywords
      const subject = event.subject || "";
      const words = subject.toLowerCase().split(/[\s\-|·:]+/).filter((w: string) => w.length > 3);
      let jobs: any[] = [];
      if (words.length > 0) {
        const jobFilter = words.slice(0, 5).map((w: string) => `company_name.ilike.%${w}%,title.ilike.%${w}%`).join(",");
        const { data: jobData } = await supabase.from("jobs").select("id, title, company_name").or(jobFilter);
        jobs = jobData || [];
      }

      const hasMatch = (candidates?.length || 0) > 0 || (contacts?.length || 0) > 0 || jobs.length > 0;

      if (hasMatch) {
        const isInterview = /interview|screen|call|debrief|onsite|intro/i.test(subject);

        const { data: task } = await supabase.from("tasks").insert({
          title: subject,
          description: event.bodyPreview || null,
          due_date: calEvent.start_at,
          assigned_to: user_id,
          created_by: user_id,
          status: "pending",
          source: "calendar",
          priority: isInterview ? "high" : "normal",
          calendar_event_id: calEvent.id,
        }).select().single();

        if (task) {
          const tags = [
            ...(candidates || []).map((c: any) => ({ task_id: task.id, entity_type: "candidate", entity_id: c.id })),
            ...(contacts || []).map((c: any) => ({ task_id: task.id, entity_type: "contact", entity_id: c.id })),
            ...jobs.map((j: any) => ({ task_id: task.id, entity_type: "job", entity_id: j.id })),
          ];
          if (tags.length) await supabase.from("task_tags").insert(tags);

          await supabase.from("calendar_events").update({
            task_id: task.id,
            match_status: "matched",
          }).eq("id", calEvent.id);
        }
        matched++;
      } else {
        await supabase.from("calendar_events").update({ match_status: "no_match" }).eq("id", calEvent.id);
        noMatch++;
      }
    }

    await supabase.from("calendar_connections").update({ last_synced_at: new Date().toISOString() }).eq("id", conn.id);

    return new Response(JSON.stringify({ success: true, synced: events.length, matched, no_match: noMatch, skipped }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sync-outlook] Error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
