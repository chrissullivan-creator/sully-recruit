import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY =
  Deno.env.get("ANTHROPIC_API_KEY") ??
  Deno.env.get("anthropic_api_key") ??
  "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CLAUDE_MODEL = "claude-sonnet-4-6";
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { candidate_id } = await req.json();
    if (!candidate_id) throw new Error("candidate_id required");

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const [candRes, notesRes, msgsRes, enrollRes, resumeRes] = await Promise.all([
      sb.from("candidates").select(`
        id, first_name, last_name, full_name, current_title, current_company,
        location_text, email, phone, linkedin_url, status, job_status,
        current_base_comp, current_bonus_comp, current_total_comp,
        target_base_comp, target_total_comp, comp_notes,
        work_authorization, relocation_preference, target_locations,
        reason_for_leaving, target_roles, candidate_summary, back_of_resume_notes,
        jobs(title, description, companies(name))
      `).eq("id", candidate_id).single(),
      sb.from("notes").select("note, created_at").eq("entity_id", candidate_id).eq("entity_type", "candidate").order("created_at", { ascending: false }).limit(20),
      sb.from("messages").select("direction, body, subject, channel, sent_at, received_at").eq("candidate_id", candidate_id).order("sent_at", { ascending: false }).limit(30),
      sb.from("sequence_enrollments").select("status, enrolled_at, sequences(name, jobs(title))").eq("candidate_id", candidate_id).order("enrolled_at", { ascending: false }).limit(10),
      sb.from("resumes").select("raw_text, parsed_json, file_name, created_at").eq("candidate_id", candidate_id).order("created_at", { ascending: false }).limit(1),
    ]);

    if (candRes.error || !candRes.data) throw new Error("Candidate not found");
    const c = candRes.data as any;
    const notes = notesRes.data ?? [];
    const msgs = msgsRes.data ?? [];
    const enrollments = enrollRes.data ?? [];
    const resume = resumeRes.data?.[0];

    const ctx: string[] = [];
    ctx.push(`CANDIDATE: ${c.full_name}`);
    ctx.push(`Title: ${c.current_title ?? "Unknown"} at ${c.current_company ?? "Unknown"}`);
    if (c.location_text) ctx.push(`Location: ${c.location_text}`);
    if (c.work_authorization) ctx.push(`Work Auth: ${c.work_authorization}`);
    if (c.relocation_preference) ctx.push(`Relocation: ${c.relocation_preference}`);
    if (c.target_locations) ctx.push(`Target Locations: ${c.target_locations}`);
    if (c.target_roles) ctx.push(`Target Roles: ${c.target_roles}`);

    const compParts: string[] = [];
    if (c.current_base_comp) compParts.push(`Base: $${Number(c.current_base_comp).toLocaleString()}`);
    if (c.current_bonus_comp) compParts.push(`Bonus: $${Number(c.current_bonus_comp).toLocaleString()}`);
    if (c.current_total_comp) compParts.push(`Total: $${Number(c.current_total_comp).toLocaleString()}`);
    if (compParts.length) ctx.push(`Current Comp: ${compParts.join(" | ")}`);
    const targetComp: string[] = [];
    if (c.target_base_comp) targetComp.push(`Base: $${Number(c.target_base_comp).toLocaleString()}`);
    if (c.target_total_comp) targetComp.push(`Total: $${Number(c.target_total_comp).toLocaleString()}`);
    if (targetComp.length) ctx.push(`Target Comp: ${targetComp.join(" | ")}`);
    if (c.comp_notes) ctx.push(`Comp Notes: ${c.comp_notes}`);
    if (c.reason_for_leaving) ctx.push(`Reason for Leaving: ${c.reason_for_leaving}`);
    if (c.candidate_summary) ctx.push(`\nExisting Summary:\n${c.candidate_summary}`);
    if (c.back_of_resume_notes) ctx.push(`\nBack of Resume Notes:\n${c.back_of_resume_notes}`);

    const job = (c as any).jobs;
    if (job) ctx.push(`\nCurrently tagged to job: ${job.title}${job.companies?.name ? ` at ${job.companies.name}` : ""}`);

    if (resume?.raw_text) ctx.push(`\nRESUME TEXT (truncated):\n${resume.raw_text.slice(0, 4000)}`);

    if (notes.length > 0) {
      ctx.push(`\nRECRUITER NOTES:`);
      notes.forEach((n: any) => ctx.push(`- ${n.note}`));
    }

    const inbound = msgs.filter((m: any) => m.direction === "inbound").slice(0, 5);
    const outbound = msgs.filter((m: any) => m.direction === "outbound").slice(0, 5);
    if (inbound.length > 0) {
      ctx.push(`\nCANDIDATE REPLIES:`);
      inbound.forEach((m: any) => ctx.push(`- ${m.body?.slice(0, 200) ?? ""}`));
    }
    if (outbound.length > 0) {
      ctx.push(`\nOUTREACH SENT:`);
      outbound.forEach((m: any) => ctx.push(`- [${m.channel}] ${m.subject ? m.subject + ": " : ""}${m.body?.slice(0, 100) ?? ""}`));
    }

    if (enrollments.length > 0) {
      ctx.push(`\nSEQUENCES:`);
      enrollments.forEach((e: any) => {
        const seqName = (e as any).sequences?.name ?? "Unknown";
        const jobTitle = (e as any).sequences?.jobs?.title;
        ctx.push(`- ${seqName} [${e.status}]${jobTitle ? ` — for ${jobTitle}` : ""}`);
      });
    }

    if (!ANTHROPIC_API_KEY) throw new Error("Anthropic API key not configured");

    const res = await fetch(CLAUDE_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        system: `You are Joe, a sharp Wall Street recruiting assistant for The Emerald Recruiting Group. Generate a "Joe Says" intelligence brief for a candidate.

The brief should be bullet points covering:
• Products / business lines / divisions they support or have supported
• Function and area of expertise (quant, tech, risk, ops, etc.)
• Reason for leaving / job change history and motivations
• Compensation history and expectations
• Key strengths and differentiators
• Any fun facts, personality notes, or memorable details
• Overall fit assessment and what roles they're best for

Rules:
- Use bullet points (•) throughout
- Be specific — use real numbers, product names, firm names from the data
- Be direct and concise — this is intel for a recruiter, not a bio
- If data is missing for a section, skip it — don't make things up
- Keep under 400 words
- Do NOT include a header/title — just the bullets`,
        messages: [
          {
            role: "user",
            content: `Generate the Joe Says brief for this candidate:\n\n${ctx.join("\n")}`,
          },
        ],
      }),
    });

    if (!res.ok) throw new Error(`Claude error: ${await res.text()}`);
    const data = await res.json();
    const joeSays = data.content?.[0]?.text?.trim() ?? "";

    await sb.from("candidates").update({
      joe_says: joeSays,
      joe_says_updated_at: new Date().toISOString(),
    }).eq("id", candidate_id);

    return new Response(JSON.stringify({ success: true, joe_says: joeSays }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[generate-joe-says] error:", err.message);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 400,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
