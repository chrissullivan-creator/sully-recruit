import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { task_id } = await req.json();
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: task } = await supabase.from("tasks")
      .select("*")
      .eq("id", task_id)
      .single();

    if (!task || !task.assigned_to || task.assigned_to === task.created_by) {
      return new Response(JSON.stringify({ skipped: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get assignee and creator profiles
    const { data: assignee } = await supabase.from("profiles")
      .select("id, email, full_name").eq("id", task.assigned_to).single();
    const { data: creator } = await supabase.from("profiles")
      .select("id, email, full_name").eq("id", task.created_by).single();

    if (!assignee?.email) {
      return new Response(JSON.stringify({ error: "No assignee email" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const dueDate = task.due_date
      ? new Date(task.due_date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
      : "No due date";
    const creatorName = creator?.full_name || "Someone";
    const assigneeName = assignee.full_name || "there";

    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) {
      console.error("[notify-task-assigned] RESEND_API_KEY not set");
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Sully Recruit <noreply@sullyrecruit.app>",
        to: assignee.email,
        subject: `Task assigned to you: ${task.title}`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;">
          <div style="background:#1C3D2E;padding:16px 24px;border-radius:10px 10px 0 0;">
            <span style="color:#C9A84C;font-weight:800;font-size:18px;">Sully Recruit</span>
          </div>
          <div style="background:#fff;border:1px solid #DDE3DE;border-top:none;border-radius:0 0 10px 10px;padding:24px;">
            <p style="color:#3D5C44;">Hi ${assigneeName},</p>
            <p><strong>${creatorName}</strong> assigned you a task:</p>
            <div style="background:#F5F7F5;border-left:4px solid #1C3D2E;border-radius:8px;padding:16px;margin:16px 0;">
              <div style="font-weight:700;font-size:16px;color:#1A2E1E;">${task.title}</div>
              ${task.description ? `<div style="font-size:13px;color:#7A9480;margin-top:6px;">${task.description}</div>` : ""}
              <div style="font-size:12px;color:#A8BCAC;margin-top:8px;">Due: <strong style="color:#1C3D2E;">${dueDate}</strong></div>
            </div>
          </div>
        </div>`,
      }),
    });

    return new Response(JSON.stringify({ sent: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-task-assigned] Error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
