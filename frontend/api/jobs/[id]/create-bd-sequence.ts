import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../../lib/auth.js";
import { callAIWithFallback } from "../../lib/ai-fallback.js";
import { inngest } from "../../lib/inngest/client.js";

/**
 * POST /api/jobs/[id]/create-bd-sequence
 *
 * Business-development outreach for a job lead. Two modes:
 *   { mode: "preview" }  -> loads the job + its attached client contacts and
 *                           asks Joe to draft a 3-touch BD email cadence
 *                           (intro -> follow-up -> breakup, 3 days apart).
 *                           Creates nothing. Returns { job, contacts, emails }.
 *   { mode: "commit", emails, contact_ids, launch } -> creates a sequence tied
 *                           to the job with the (possibly edited) 3 emails. When
 *                           launch=true it also enrolls the selected contacts and
 *                           fires enrollment-init so sends begin; launch=false
 *                           leaves it as a reviewable draft. Returns { sequence_id }.
 *
 * The drafts use {{first_name}} and {{job_name}} merge tags, which the sequence
 * engine substitutes at send time (the sequence is tied to the job via job_id).
 */

const STEP_DELAYS_HOURS = [0, 72, 72]; // day 0, +3 days, +3 days
const STEP_LABELS = ["Intro", "Follow-up", "Breakup"];

function stripHtml(s: string): string {
  return (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

type BdEmail = { subject: string; body: string };

function fallbackEmails(jobName: string): BdEmail[] {
  return [
    {
      subject: `Resumes for your ${jobName} search`,
      body:
        `Hi {{first_name}},\n\n` +
        `I noticed you're hiring for a {{job_name}}. Roles like this are tough to fill right now — the people who can actually do the job aren't on the open market, and the ones who are tend to look great on paper and stall in the interview.\n\n` +
        `That's our lane. We work this market every day, and 75% of the candidates we send get interviews. I'd love to show you a few resumes — no obligation, just a look at who's actually out there.\n\n` +
        `Are you open to that?`,
    },
    {
      subject: "",
      body:
        `Hi {{first_name}},\n\n` +
        `Following up on my note about the {{job_name}} search. I have a couple of profiles I think would genuinely move the needle for you — quietly, off-market.\n\n` +
        `Worth a quick look? I can send them over today.`,
    },
    {
      subject: "",
      body:
        `Hi {{first_name}},\n\n` +
        `I'll assume you're all set on the {{job_name}} search for now. If anything changes, keep me in mind — I'm happy to send resumes over whenever the timing's right.\n\n` +
        `Best,`,
    },
  ];
}

async function draftBdEmails(opts: {
  jobName: string;
  company: string;
  jobDesc: string;
  senderName: string;
}): Promise<BdEmail[]> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY || process.env.anthropic_api_key || "";
  const openaiKey = process.env.OPENAI_API_KEY || "";
  const geminiKey = process.env.GEMINI_API_KEY || "";
  const openRouterKey = process.env.OPENROUTER_API_KEY || "";
  if (!anthropicKey && !openaiKey && !geminiKey && !openRouterKey) {
    return fallbackEmails(opts.jobName);
  }

  const prompt = `You are Joe, a senior Wall Street recruiter at The Emerald Recruiting Group. Write a 3-email BUSINESS-DEVELOPMENT cadence to a HIRING MANAGER / CLIENT CONTACT who is hiring for a role. The goal is to win the search — get permission to send them candidate resumes.

This is OUTBOUND BD to the CLIENT, not candidate outreach. So you DO reference the role they are hiring for. Do NOT pitch a candidate to a candidate.

ROLE THEY ARE HIRING FOR: ${opts.jobName}
${opts.company ? `THEIR FIRM (context only, don't necessarily name it): ${opts.company}` : ""}
${opts.jobDesc ? `ROLE DETAILS (use to name a SPECIFIC, credible hiring challenge): ${opts.jobDesc.slice(0, 1200)}` : ""}
SENDER: ${opts.senderName}, The Emerald Recruiting Group

The 3 emails:
1) INTRO — Open with "I noticed you're hiring for a {{job_name}}." Name ONE specific, real challenge a firm faces filling THIS kind of role (be concrete to the role, not generic). Then the credibility line: 75% of the candidates we send get interviews. Say this is right up our alley and you'd love to show them a few resumes. End with a low-friction ask: "Are you open to that?"
2) FOLLOW-UP — A short bump on email 1. Assume they saw it. Re-offer to send a couple of strong, off-market profiles. One soft ask. This threads as a reply, so NO subject line.
3) BREAKUP — Gracious final note: "I'll assume you're all set on the {{job_name}} search for now — if anything changes, let me know / keep me in mind." Leave the door open. Threads as a reply, NO subject line.

VOICE: Confident, direct, warm, zero fluff. Never "I hope this finds you well", never "circle back" / "touch base" / "leverage" (verb) / "synergy". Every sentence earns its place.

MERGE TAGS: use {{first_name}} for the contact's first name and {{job_name}} for the role. Use them literally — do not invent a name.

Return ONLY a JSON array of exactly 3 objects, no markdown, no preamble:
[{"subject":"...","body":"..."},{"subject":"","body":"..."},{"subject":"","body":"..."}]
Email 1 has a sharp subject line. Emails 2 and 3 have an empty subject (they reply in-thread). Bodies are plain text with \\n line breaks and should start with "Hi {{first_name}},".`;

  try {
    // Cap the draft call so a slow/hanging provider can't blow the function's
    // time budget (which would return an empty body to the client). On timeout
    // the catch below ships the solid template instead.
    const ai = await Promise.race([
      callAIWithFallback({
        anthropicKey: anthropicKey || undefined,
        openaiKey: openaiKey || undefined,
        geminiKey: geminiKey || undefined,
        openRouterKey: openRouterKey || undefined,
        systemPrompt: "You are Joe, a Wall Street BD copywriter. Output strictly valid JSON.",
        userContent: prompt,
        model: "claude-sonnet-4-6",
        maxTokens: 1400,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ai_timeout")), 12_000)),
    ]);
    const { text } = ai as { text: string };
    const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    const json = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    const parsed = JSON.parse(json) as BdEmail[];
    if (!Array.isArray(parsed) || parsed.length < 3) throw new Error("expected 3 emails");
    return parsed.slice(0, 3).map((e, i) => ({
      subject: i === 0 ? (e.subject || `Resumes for your ${opts.jobName} search`) : "",
      body: (e.body || "").trim(),
    }));
  } catch (_e) {
    // AI unavailable (e.g. no credits) or unparseable — ship a solid template.
    return fallbackEmails(opts.jobName);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const jobId = req.query.id as string;
  if (!jobId) return res.status(400).json({ error: "Missing job id" });

  // Resolve Supabase creds defensively. Production has SUPABASE_URL; preview
  // deployments often don't (only VITE_* are exposed), and a bare
  // createClient(undefined, …) throws "supabaseUrl is required" BEFORE we can
  // send JSON — the client then chokes on an empty body ("Unexpected end of
  // JSON input"). Fall back to the VITE_ URL and, if creds are truly absent,
  // return a clear JSON error instead of crashing.
  const supabaseUrl =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      error:
        "Server misconfigured: missing Supabase credentials (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY). Preview deployments may not have these set — try the production URL.",
    });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const { data: job, error: jobErr } = await supabase
    .from("jobs")
    .select("id, title, company_name, company_id, contact_id, status, marketing_title, marketing_job_description, description")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) return res.status(500).json({ error: jobErr.message });
  if (!job) return res.status(404).json({ error: "Job not found" });

  const jobName = (job as any).title || (job as any).marketing_title || "this role";
  const company = (job as any).company_name || "";
  const jobDesc = stripHtml((job as any).marketing_job_description || (job as any).description || "");

  // Resolve the client contacts attached to this job: job_contacts + the
  // job's primary contact_id. Filter to those we can actually email.
  const { data: jcRows } = await supabase
    .from("job_contacts")
    .select("contact_id, is_primary, role")
    .eq("job_id", jobId);
  const idSet = new Set<string>();
  for (const r of (jcRows || []) as any[]) if (r.contact_id) idSet.add(r.contact_id);
  if ((job as any).contact_id) idSet.add((job as any).contact_id);

  let contacts: Array<{ id: string; first_name: string; full_name: string | null; title: string | null; email: string | null }> = [];
  if (idSet.size) {
    const { data: people } = await supabase
      .from("people")
      .select("id, first_name, full_name, title, work_email, personal_email, primary_email")
      .in("id", [...idSet]);
    contacts = ((people || []) as any[]).map((p) => ({
      id: p.id,
      first_name: p.first_name || (p.full_name || "").split(" ")[0] || "there",
      full_name: p.full_name,
      title: p.title,
      email: p.work_email || p.primary_email || p.personal_email || null,
    }));
  }

  const mode = req.body?.mode === "commit" ? "commit" : "preview";

  // ---- PREVIEW ----
  if (mode === "preview") {
    const emails = await draftBdEmails({ jobName, company, jobDesc, senderName: "the Emerald team" });
    return res.status(200).json({
      job: { id: (job as any).id, title: jobName, company, status: (job as any).status },
      contacts,
      emails,
    });
  }

  // ---- COMMIT ----
  const body = req.body || {};
  const emails: BdEmail[] = Array.isArray(body.emails) && body.emails.length >= 1 ? body.emails.slice(0, 3) : await draftBdEmails({ jobName, company, jobDesc, senderName: "the Emerald team" });
  while (emails.length < 3) emails.push(fallbackEmails(jobName)[emails.length]);
  const launch = body.launch === true;

  const validIds = new Set(contacts.map((c) => c.id));
  const requested: string[] = Array.isArray(body.contact_ids) ? body.contact_ids : contacts.map((c) => c.id);
  const enrollIds = requested.filter((cid) => validIds.has(cid));

  // `jobs` has no owner/recruiter column — the BD sequence is sent by the
  // recruiter running it.
  const senderId = auth.userId;

  // 1. sequence
  const { data: seq, error: seqErr } = await supabase
    .from("sequences")
    .insert({
      name: `BD — ${jobName}${company ? ` @ ${company}` : ""}`,
      job_id: (job as any).id,
      job_ids: [(job as any).id],
      audience_type: "contacts",
      objective: `Business development — win the ${jobName} search`,
      send_window_start: "09:00",
      send_window_end: "18:00",
      timezone: "America/New_York",
      weekdays_only: true,
      created_by: auth.userId,
      sender_user_id: senderId,
      status: launch ? "active" : "draft",
    } as any)
    .select("id")
    .single();
  if (seqErr) return res.status(500).json({ error: `Could not create sequence: ${seqErr.message}` });
  const sequenceId = (seq as any).id as string;

  // 2. nodes + actions (one node per email; 1-based order; first email carries
  //    the subject, follow-ups thread as replies)
  for (let i = 0; i < 3; i++) {
    const nodeId = randomUUID();
    const { error: nodeErr } = await supabase.from("sequence_nodes").insert({
      id: nodeId,
      sequence_id: sequenceId,
      node_order: i + 1,
      node_type: "action",
      label: STEP_LABELS[i],
      branch_id: "branch_a",
      branch_step_order: i + 1,
    } as any);
    if (nodeErr) return res.status(500).json({ error: `Could not create step ${i + 1}: ${nodeErr.message}` });

    const { error: actErr } = await supabase.from("sequence_actions").insert({
      id: randomUUID(),
      node_id: nodeId,
      channel: "email",
      message_body: emails[i].body || "",
      subject_line: i === 0 ? (emails[i].subject || `Resumes for your ${jobName} search`) : null,
      base_delay_hours: STEP_DELAYS_HOURS[i],
      jiggle_minutes: 15,
      use_signature: true,
      reply_to_previous: i > 0,
    } as any);
    if (actErr) return res.status(500).json({ error: `Could not create email ${i + 1}: ${actErr.message}` });
  }

  // 3. enroll + fire init (only when launching; a draft is enrolled later from
  //    the builder so we don't pre-schedule against emails the user may rewrite)
  let enrolled = 0;
  if (launch && enrollIds.length) {
    const rows = enrollIds.map((cid) => ({
      sequence_id: sequenceId,
      contact_id: cid,
      status: "active",
      enrolled_by: auth.userId,
    }));
    const { data: inserted, error: enrErr } = await supabase
      .from("sequence_enrollments")
      .insert(rows)
      .select("id, sequence_id, contact_id, enrolled_by");
    if (enrErr) return res.status(500).json({ error: `Sequence created but enrollment failed: ${enrErr.message}`, sequence_id: sequenceId });

    const events = ((inserted || []) as any[]).map((row) => ({
      id: `enrollment-init-${row.id}`,
      name: "sequence/enrollment-init.requested",
      data: {
        enrollmentId: row.id,
        sequenceId: row.sequence_id,
        contactId: row.contact_id,
        enrolledBy: row.enrolled_by,
      },
    }));
    if (events.length) await inngest.send(events);
    enrolled = events.length;
  }

  return res.status(200).json({ sequence_id: sequenceId, status: launch ? "active" : "draft", enrolled });
}
