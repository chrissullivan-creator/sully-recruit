import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { inngest } from "./lib/inngest/client.js";

/**
 * POST /api/mcp  — Model Context Protocol server for Sully Recruit.
 *
 * Speaks MCP over Streamable HTTP (JSON-RPC 2.0). Exposes read + write tools
 * over the CRM so an MCP client (ChatGPT Developer Mode, Claude, Claude Code,
 * or our own Joe layer) can search, answer pipeline questions, edit people,
 * move pipeline stages, and create/enroll sequences.
 *
 * Transport: a single POST endpoint. We content-negotiate the response —
 * `text/event-stream` (what ChatGPT sends in Accept) gets one SSE `message`
 * event; everything else gets plain JSON (what Claude Code is happy with).
 * Stateless: no Mcp-Session-Id is issued.
 *
 * Auth: a shared bearer token (`MCP_AUTH_TOKEN`). In ChatGPT you paste this as
 * the connector's API key; it arrives here as `Authorization: Bearer <token>`.
 * The server then acts with the Supabase service role and attributes writes to
 * `MCP_ACTOR_USER_ID` (defaults to Chris).
 *
 * Guardrails baked in (so tools can't violate app invariants):
 *   - person status limited to new | reached_out | engaged
 *   - pipeline_stage limited to the candidate_jobs ladder
 *   - emails routed to personal_/work_ via consumer-domain classification
 *     (never the dropped `email` column)
 *   - enroll_people refuses anyone flagged do_not_contact
 *   - raw SQL is read-only, capped, and OFF unless MCP_ENABLE_RAW_SQL=true
 */

// ── config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
// Fallback actor for the shared token (Claude Code / admin path). Per-user
// tokens in the mcp_tokens table override this so each recruiter's writes are
// attributed to THEM. Defaults to Chris; override with MCP_ACTOR_USER_ID.
const ACTOR_DEFAULT = process.env.MCP_ACTOR_USER_ID || "fc07e240-0e31-45d4-a8f1-ddec1042dd5f";
const ACTOR_NAME_DEFAULT = process.env.MCP_ACTOR_NAME || "Joe (MCP)";
const RAW_SQL_ENABLED = process.env.MCP_ENABLE_RAW_SQL !== "false";

type Actor = { userId: string; name: string };
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Resolve which recruiter a request acts as, from its bearer token:
 *   1. A per-user token in mcp_tokens (stored as a SHA-256 hash) → that user,
 *      so Chris / Nancy / Ashley each get their own attribution.
 *   2. The shared MCP_AUTH_TOKEN → the default actor (Chris). Used by Claude
 *      Code / admin.
 * Returns null if the token matches neither (→ 401).
 */
async function resolveActor(sb: SupabaseClient, token: string): Promise<Actor | null> {
  const hash = sha256hex(token);
  try {
    const { data } = await sb
      .from("mcp_tokens")
      .select("user_id, label")
      .eq("token_sha256", hash)
      .eq("is_active", true)
      .maybeSingle();
    if ((data as any)?.user_id) {
      void sb.from("mcp_tokens").update({ last_used_at: now() } as any).eq("token_sha256", hash);
      return { userId: (data as any).user_id, name: (data as any).label || "MCP" };
    }
  } catch {
    /* table missing (e.g. preview branch DB) — fall through to the shared token */
  }
  if (MCP_AUTH_TOKEN && token === MCP_AUTH_TOKEN) {
    return { userId: ACTOR_DEFAULT, name: ACTOR_NAME_DEFAULT };
  }
  return null;
}

const VALID_STATUSES = ["new", "reached_out", "engaged"];
const PIPELINE_STAGES = [
  "new", "reached_out", "pitched", "send_out", "submitted",
  "interviewing", "offer", "placed", "rejected", "withdrew",
];

// Consumer email domains → personal_email; everything else → work_email.
// Kept in sync with /api/add-person and the Postgres is_consumer_email_domain().
const CONSUMER_EMAIL_DOMAINS =
  /^(gmail|yahoo|hotmail|outlook|icloud|me|mac|aol|msn|live|protonmail|proton|fastmail|comcast|verizon|sbcglobal|att|optonline|ymail|hush|gmx|zoho|tutanota|cox|charter|earthlink|bellsouth|hanmail|naver)\.[a-z.]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── small helpers ─────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const low = (s: unknown) => (typeof s === "string" ? s.trim().toLowerCase() : null);
const sanitize = (s: unknown) => String(s ?? "").replace(/[%,]/g, " ").trim();
const clamp = (v: unknown, dflt: number, max: number) =>
  Math.min(Math.max(Number(v) || dflt, 1), max);
const isConsumer = (addr: string) => {
  const at = addr.indexOf("@");
  return at >= 0 && CONSUMER_EMAIL_DOMAINS.test(addr.slice(at + 1).toLowerCase());
};
function countBy(rows: any[] | null | undefined, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows ?? []) {
    const k = (r?.[key] ?? "unknown") as string;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
async function addNote(sb: SupabaseClient, actor: Actor, entity_type: string, entity_id: string, note: string) {
  const { data, error } = await sb
    .from("notes")
    .insert({ entity_type, entity_id, note, created_by: actor.name, note_source: "mcp" } as any)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { note_id: (data as any).id, entity_type, entity_id };
}

// ── tool catalog (what the client sees) ──────────────────────────────────────
const TOOLS = [
  {
    name: "search",
    description:
      "Search across the CRM. entity 'all' (default) returns matching people, jobs, and companies; or narrow with 'people' | 'candidate' | 'client' | 'job' | 'company'. Use this first to get IDs for other tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free text over names, titles, companies, emails." },
        entity: { type: "string", enum: ["all", "people", "candidate", "client", "job", "company"] },
        limit: { type: "number", description: "Max rows per entity (default 10, max 50)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_person",
    description: "Full profile for one candidate/client by id or email, optionally with their recent activity timeline.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        email: { type: "string" },
        include_activity: { type: "boolean", description: "Include v_person_activity timeline." },
        activity_limit: { type: "number", description: "Default 20, max 100." },
      },
    },
  },
  {
    name: "get_job",
    description: "One job with its pipeline: candidates tagged to it, their stages, and per-stage counts.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "get_company",
    description: "One company (by id or name) with its linked people and jobs.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
  },
  {
    name: "pipeline_report",
    description: "Pipeline-stage counts for a single job (pass job_id) or across all jobs (omit job_id).",
    inputSchema: { type: "object", properties: { job_id: { type: "string" } } },
  },
  {
    name: "last_touch",
    description:
      "When did we last follow up? For a person (person_id) returns last outbound/inbound message + last_contacted/responded timestamps. For a job (job_id) returns its candidates ordered by last_contacted_at.",
    inputSchema: { type: "object", properties: { person_id: { type: "string" }, job_id: { type: "string" } } },
  },
  {
    name: "query",
    description:
      "Run read-only SQL (SELECT/WITH only, max 1000 rows, 8s) for any ad-hoc question the other tools don't cover — counts, 'latest/most recent', filters, cross-table joins. Tip: call describe_schema first for exact column names. Real enum values: jobs.status = lead|hot|closed_lost; people.status = new|reached_out|engaged.",
    inputSchema: { type: "object", properties: { sql: { type: "string", description: "A single SELECT or WITH statement." } }, required: ["sql"] },
  },
  {
    name: "describe_schema",
    description: "Introspect the database. Omit 'table' to list all tables/views; pass a table name to get its columns + types. Use this before writing a query so column names are exact.",
    inputSchema: { type: "object", properties: { table: { type: "string", description: "Optional table/view name." } } },
  },
  {
    name: "list_jobs",
    description: "List jobs newest-first, optionally filtered by status (lead | hot | closed_lost). Answers e.g. 'the latest hot job'.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "lead | hot | closed_lost" },
        limit: { type: "number", description: "Default 20, max 100." },
      },
    },
  },
  {
    name: "add_person",
    description:
      "Create a candidate or client. Auto-merges into an existing row if an email matches (appends the role instead of duplicating). Emails are auto-classified into personal/work.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["candidate", "client"] },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        personal_email: { type: "string" },
        work_email: { type: "string" },
        phone: { type: "string" },
        linkedin_url: { type: "string" },
        title: { type: "string" },
        company: { type: "string" },
        company_id: { type: "string" },
        location: { type: "string" },
        notes: { type: "string" },
      },
      required: ["role", "first_name", "last_name"],
    },
  },
  {
    name: "update_person",
    description:
      "Patch fields on a person. Allowed: first_name,last_name,full_name,phone,mobile_phone,linkedin_url,current_title,current_company,title,company_name,company_id,location_text,status,candidate_summary,next_action,do_not_contact, plus personal_email/work_email/email (auto-classified). status must be new|reached_out|engaged.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, fields: { type: "object" } },
      required: ["id", "fields"],
    },
  },
  {
    name: "set_do_not_contact",
    description: "Flag/unflag a person as do-not-contact (blocks future sequence enrollment).",
    inputSchema: {
      type: "object",
      properties: { person_id: { type: "string" }, value: { type: "boolean" } },
      required: ["person_id"],
    },
  },
  {
    name: "add_note",
    description: "Log a note on a person (pass person_id) or any entity (entity_type + entity_id).",
    inputSchema: {
      type: "object",
      properties: {
        person_id: { type: "string" },
        entity_type: { type: "string", description: "candidate|contact|job|company|send_out" },
        entity_id: { type: "string" },
        note: { type: "string" },
      },
      required: ["note"],
    },
  },
  {
    name: "tag_person_to_job",
    description: "Attach a person to a job (creates the candidate_jobs pipeline link). Idempotent per (candidate, job).",
    inputSchema: {
      type: "object",
      properties: {
        candidate_id: { type: "string" },
        job_id: { type: "string" },
        pipeline_stage: { type: "string", description: "Defaults to 'new'." },
      },
      required: ["candidate_id", "job_id"],
    },
  },
  {
    name: "set_pipeline_stage",
    description: `Move a person to a pipeline stage on a job. Stage must be one of: ${PIPELINE_STAGES.join(", ")}. Creates the link if missing.`,
    inputSchema: {
      type: "object",
      properties: {
        candidate_id: { type: "string" },
        job_id: { type: "string" },
        pipeline_stage: { type: "string", enum: PIPELINE_STAGES },
      },
      required: ["candidate_id", "job_id", "pipeline_stage"],
    },
  },
  {
    name: "list_sequences",
    description: "List outreach sequences (most recent first), optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", description: "draft|active|archived" }, limit: { type: "number" } },
    },
  },
  {
    name: "create_sequence",
    description:
      "Create a multi-step outreach sequence (nodes + actions). audience 'candidates' or 'contacts'. Each step: {channel?(email|linkedin|sms), subject?, body, delay_hours?, label?}. Step 1 carries the subject; later steps thread as replies. Created as 'draft' unless launch=true. Use enroll_people to start sends.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        audience: { type: "string", enum: ["candidates", "contacts"] },
        objective: { type: "string" },
        job_id: { type: "string" },
        channel: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              channel: { type: "string" },
              subject: { type: "string" },
              body: { type: "string" },
              delay_hours: { type: "number" },
              label: { type: "string" },
            },
            required: ["body"],
          },
        },
        launch: { type: "boolean" },
        send_window_start: { type: "string" },
        send_window_end: { type: "string" },
        timezone: { type: "string" },
        weekdays_only: { type: "boolean" },
        stop_on_reply: { type: "boolean" },
      },
      required: ["name", "steps"],
    },
  },
  {
    name: "enroll_people",
    description:
      "Enroll people into a sequence and begin sends (fires the enrollment-init engine event). Skips anyone flagged do_not_contact and anyone already actively enrolled.",
    inputSchema: {
      type: "object",
      properties: {
        sequence_id: { type: "string" },
        person_ids: { type: "array", items: { type: "string" } },
      },
      required: ["sequence_id", "person_ids"],
    },
  },
  {
    name: "set_enrollment_status",
    description: "Pause, stop, or re-activate a single sequence enrollment.",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_id: { type: "string" },
        status: { type: "string", enum: ["active", "paused", "stopped"] },
        reason: { type: "string" },
      },
      required: ["enrollment_id", "status"],
    },
  },
  {
    name: "add_company",
    description: "Create a company (dedupes by name — returns the existing one if the name already exists). company_status: target (prospect) | client.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        company_type: { type: "string", description: "Firm type, e.g. Hedge Fund, Asset Manager, Investment Bank, Private Equity, Fintech." },
        company_status: { type: "string", description: "target | client (default target)." },
        industry: { type: "string" },
        location: { type: "string" },
        hq_location: { type: "string" },
        domain: { type: "string" },
        website: { type: "string" },
        linkedin_url: { type: "string" },
        description: { type: "string" },
      },
      required: ["name"],
    },
  },
  {
    name: "update_company",
    description: "Edit a company's fields by id (name, company_type, company_status, industry, location, hq_location, domain, website, linkedin_url, description).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] },
  },
  {
    name: "add_job",
    description: "Create a job/search/req. Resolves company_id from the 'company' name when given; status defaults to 'lead' (lead|hot|closed_lost). Optionally pass hiring_manager_id (a person id) to attach them as the primary job contact. Dedupes on job_url.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        company: { type: "string", description: "Company name (auto-linked to an existing company)." },
        company_id: { type: "string" },
        status: { type: "string", enum: ["lead", "hot", "closed_lost"] },
        location: { type: "string" },
        description: { type: "string" },
        compensation: { type: "string" },
        num_openings: { type: "number" },
        submittal_instructions: { type: "string" },
        additional_notes: { type: "string" },
        job_url: { type: "string" },
        hiring_manager_id: { type: "string", description: "Person id to attach as the primary hiring-manager contact." },
      },
      required: ["title"],
    },
  },
  {
    name: "update_job",
    description: "Edit a job by id (title, status [lead|hot|closed_lost], location, description, compensation, num_openings, company_id, company_name, contact_id, submittal_instructions, additional_notes, job_url, job_code).",
    inputSchema: { type: "object", properties: { id: { type: "string" }, fields: { type: "object" } }, required: ["id", "fields"] },
  },
  {
    name: "add_job_contact",
    description: "Attach a person (hiring manager / client contact) to a job. Idempotent per (job, person). Set is_primary to also make them the job's primary contact.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "string" },
        person_id: { type: "string" },
        is_primary: { type: "boolean" },
        role: { type: "string", description: "Optional label, e.g. 'Hiring Manager', 'HR'." },
      },
      required: ["job_id", "person_id"],
    },
  },
  {
    name: "link_person_to_company",
    description: "Link a person (candidate/client) to a company. Pass company_id, or company_name to resolve/attach by name.",
    inputSchema: {
      type: "object",
      properties: {
        person_id: { type: "string" },
        company_id: { type: "string" },
        company_name: { type: "string" },
      },
      required: ["person_id"],
    },
  },
];

// ── tool implementations ──────────────────────────────────────────────────────
async function runTool(sb: SupabaseClient, actor: Actor, name: string, args: Record<string, any>): Promise<any> {
  switch (name) {
    case "search": {
      const q = sanitize(args.query);
      if (!q) throw new Error("query required");
      const limit = clamp(args.limit, 10, 50);
      const entity = args.entity ?? "all";
      const out: any = {};
      if (["all", "people", "candidate", "client"].includes(entity)) {
        let pq = sb
          .from("people")
          .select("id, full_name, type, roles, current_title, current_company, company_name, title, primary_email, status, location_text, do_not_contact")
          .or(`full_name.ilike.%${q}%,current_title.ilike.%${q}%,current_company.ilike.%${q}%,company_name.ilike.%${q}%,primary_email.ilike.%${q}%`)
          .limit(limit);
        if (entity === "candidate") pq = pq.contains("roles", ["candidate"]);
        if (entity === "client") pq = pq.contains("roles", ["client"]);
        const { data, error } = await pq;
        if (error) throw new Error(error.message);
        out.people = data;
      }
      if (["all", "job"].includes(entity)) {
        const { data, error } = await sb
          .from("jobs")
          .select("id, title, company_name, status, location, created_at")
          .is("deleted_at", null)
          .or(`title.ilike.%${q}%,company_name.ilike.%${q}%`)
          .limit(limit);
        if (error) throw new Error(error.message);
        out.jobs = data;
      }
      if (["all", "company"].includes(entity)) {
        const { data, error } = await sb
          .from("companies")
          .select("id, name, company_type, industry, location, domain")
          .is("deleted_at", null)
          .ilike("name", `%${q}%`)
          .limit(limit);
        if (error) throw new Error(error.message);
        out.companies = data;
      }
      return out;
    }

    case "get_person": {
      const sel =
        "id, full_name, first_name, last_name, type, roles, status, current_title, current_company, company_name, title, company_id, primary_email, personal_email, work_email, phone, mobile_phone, linkedin_url, location_text, candidate_summary, next_action, do_not_contact, owner_user_id, last_contacted_at, last_responded_at";
      let pq = sb.from("people").select(sel).limit(1);
      if (args.id) pq = pq.eq("id", args.id);
      else if (args.email) {
        const e = low(args.email)!;
        pq = pq.or(`primary_email.ilike.${e},personal_email.ilike.${e},work_email.ilike.${e}`);
      } else throw new Error("Provide id or email");
      const { data: person, error } = await pq.maybeSingle();
      if (error) throw new Error(error.message);
      if (!person) return { found: false };
      const result: any = { found: true, person };
      if (args.include_activity) {
        const lim = clamp(args.activity_limit, 20, 100);
        const { data: acts } = await sb
          .from("v_person_activity")
          .select("activity_type, happened_at, summary, source_table")
          .eq("person_id", (person as any).id)
          .order("happened_at", { ascending: false })
          .limit(lim);
        result.activity = acts;
      }
      return result;
    }

    case "get_job": {
      if (!args.id) throw new Error("id required");
      const { data: job, error } = await sb
        .from("jobs")
        .select("id, title, company_name, company_id, status, location, compensation, description, num_openings, created_at")
        .eq("id", args.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!job) return { found: false };
      const { data: cj } = await sb
        .from("candidate_jobs")
        .select("candidate_id, pipeline_stage, stage_updated_at")
        .eq("job_id", args.id);
      const ids = (cj ?? []).map((r: any) => r.candidate_id);
      const names: Record<string, any> = {};
      if (ids.length) {
        const { data: ppl } = await sb.from("people").select("id, full_name, current_title, current_company").in("id", ids);
        for (const p of ppl ?? []) names[(p as any).id] = p;
      }
      const candidates = (cj ?? []).map((r: any) => ({
        candidate_id: r.candidate_id,
        stage: r.pipeline_stage,
        stage_updated_at: r.stage_updated_at,
        ...(names[r.candidate_id] ?? {}),
      }));
      return { found: true, job, pipeline_counts: countBy(cj, "pipeline_stage"), total: candidates.length, candidates };
    }

    case "get_company": {
      let cq = sb
        .from("companies")
        .select("id, name, company_type, industry, size, location, hq_location, domain, website, description")
        .limit(1);
      if (args.id) cq = cq.eq("id", args.id);
      else if (args.name) cq = cq.ilike("name", sanitize(args.name));
      else throw new Error("Provide id or name");
      const { data: company, error } = await cq.maybeSingle();
      if (error) throw new Error(error.message);
      if (!company) return { found: false };
      const cid = (company as any).id;
      const { data: people } = await sb.from("people").select("id, full_name, title, current_title, type").eq("company_id", cid).limit(100);
      const { data: jobs } = await sb.from("jobs").select("id, title, status").eq("company_id", cid).is("deleted_at", null);
      return { found: true, company, people, jobs };
    }

    case "pipeline_report": {
      if (args.job_id) {
        const { data: cj, error } = await sb.from("candidate_jobs").select("pipeline_stage").eq("job_id", args.job_id);
        if (error) throw new Error(error.message);
        return { scope: "job", job_id: args.job_id, counts: countBy(cj, "pipeline_stage"), total: (cj ?? []).length };
      }
      const { data: cj, error } = await sb.from("candidate_jobs").select("pipeline_stage");
      if (error) throw new Error(error.message);
      return { scope: "all", counts: countBy(cj, "pipeline_stage"), total: (cj ?? []).length };
    }

    case "last_touch": {
      if (args.person_id) {
        const { data: person } = await sb
          .from("people")
          .select("id, full_name, last_contacted_at, last_responded_at")
          .eq("id", args.person_id)
          .maybeSingle();
        const { data: msgs } = await sb
          .from("messages")
          .select("channel, direction, subject, body, sent_at, created_at")
          .eq("candidate_id", args.person_id)
          .order("sent_at", { ascending: false, nullsFirst: false })
          .limit(5);
        return {
          person,
          last_contacted_at: (person as any)?.last_contacted_at ?? null,
          last_responded_at: (person as any)?.last_responded_at ?? null,
          last_outbound: (msgs ?? []).find((m: any) => m.direction === "outbound") ?? null,
          last_inbound: (msgs ?? []).find((m: any) => m.direction === "inbound") ?? null,
          recent_messages: msgs,
        };
      }
      if (args.job_id) {
        const { data: cj } = await sb.from("candidate_jobs").select("candidate_id, pipeline_stage").eq("job_id", args.job_id);
        const ids = (cj ?? []).map((r: any) => r.candidate_id);
        if (!ids.length) return { job_id: args.job_id, people: [] };
        const { data: ppl } = await sb
          .from("people")
          .select("id, full_name, last_contacted_at, last_responded_at")
          .in("id", ids)
          .order("last_contacted_at", { ascending: false, nullsFirst: false });
        return { job_id: args.job_id, people: ppl };
      }
      throw new Error("Provide person_id or job_id");
    }

    case "query": {
      if (!RAW_SQL_ENABLED) throw new Error("Raw SQL tool is disabled. Set MCP_ENABLE_RAW_SQL=true to enable it.");
      const sql = String(args.sql ?? "").trim();
      if (!/^(select|with)\b/i.test(sql)) throw new Error("Only SELECT / WITH queries are allowed.");
      const { data, error } = await sb.rpc("mcp_run_read_query", { query_text: sql });
      if (error) throw new Error(error.message);
      return data;
    }

    case "describe_schema": {
      const t = typeof args.table === "string" ? args.table.replace(/[^a-zA-Z0-9_]/g, "") : "";
      const q = t
        ? `select column_name, data_type from information_schema.columns where table_schema='public' and table_name='${t}' order by ordinal_position`
        : `select table_name, table_type from information_schema.tables where table_schema='public' order by table_name`;
      const { data, error } = await sb.rpc("mcp_run_read_query", { query_text: q });
      if (error) throw new Error(error.message);
      return data;
    }

    case "list_jobs": {
      const limit = clamp(args.limit, 20, 100);
      let q = sb.from("jobs")
        .select("id, title, company_name, status, location, num_openings, created_at, updated_at")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (args.status) q = q.eq("status", args.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data;
    }

    case "add_person": {
      const role = args.role === "candidate" ? "candidate" : "client";
      if (!args.first_name || !args.last_name) throw new Error("first_name and last_name required");
      const email = low(args.email), personal = low(args.personal_email), work = low(args.work_email);
      for (const a of [email, personal, work]) if (a && !EMAIL_RE.test(a)) throw new Error(`Invalid email: ${a}`);
      let existing: any = null;
      for (const e of [email, personal, work].filter(Boolean) as string[]) {
        const { data: rows } = await sb
          .from("people")
          .select("id, roles")
          .or(`primary_email.ilike.${e},personal_email.ilike.${e},work_email.ilike.${e}`)
          .limit(1);
        if (rows?.[0]) { existing = rows[0]; break; }
      }
      if (existing) {
        const current: string[] = Array.isArray(existing.roles) && existing.roles.length ? existing.roles : [role];
        const merged = current.includes(role) ? current : [...current, role];
        const { error } = await sb.from("people").update({ roles: merged, updated_at: now() } as any).eq("id", existing.id);
        if (error) throw new Error(error.message);
        return { id: existing.id, merged: true, roles: merged };
      }
      let rp = personal, rw = work;
      if (email && !rp && !rw) { if (isConsumer(email)) rp = email; else rw = email; }
      const payload: any = {
        first_name: String(args.first_name).trim(),
        last_name: String(args.last_name).trim(),
        full_name: `${String(args.first_name).trim()} ${String(args.last_name).trim()}`.trim(),
        personal_email: rp ?? null,
        work_email: rw ?? null,
        phone: args.phone?.trim() || null,
        linkedin_url: args.linkedin_url?.trim() || null,
        roles: [role],
        status: "new",
        owner_user_id: actor.userId,
        created_by_user_id: actor.userId,
      };
      if (role === "candidate") {
        payload.current_title = args.title?.trim() || null;
        payload.current_company = args.company?.trim() || null;
      } else {
        payload.title = args.title?.trim() || null;
        payload.company_name = args.company?.trim() || null;
        if (args.company_id) payload.company_id = args.company_id;
      }
      payload.location_text = args.location?.trim() || null;
      const { data: row, error } = await sb.from("people").insert(payload).select("id, roles").single();
      if (error) throw new Error(error.message);
      if (args.notes?.trim()) await addNote(sb, actor, role === "candidate" ? "candidate" : "contact", (row as any).id, args.notes.trim());
      return { id: (row as any).id, merged: false, roles: (row as any).roles };
    }

    case "update_person": {
      if (!args.id) throw new Error("id required");
      const fields = (args.fields ?? {}) as Record<string, any>;
      const allow = [
        "first_name", "last_name", "full_name", "phone", "mobile_phone", "linkedin_url",
        "current_title", "current_company", "title", "company_name", "company_id",
        "location_text", "status", "candidate_summary", "next_action", "do_not_contact",
      ];
      const patch: any = {};
      for (const k of allow) if (k in fields && fields[k] !== undefined) patch[k] = fields[k];
      if ("status" in patch && !VALID_STATUSES.includes(patch.status))
        throw new Error(`Invalid status. Allowed: ${VALID_STATUSES.join(", ")}`);
      if (fields.personal_email) patch.personal_email = low(fields.personal_email);
      if (fields.work_email) patch.work_email = low(fields.work_email);
      if (fields.email) { const e = low(fields.email)!; if (isConsumer(e)) patch.personal_email = e; else patch.work_email = e; }
      for (const k of ["personal_email", "work_email"]) if (patch[k] && !EMAIL_RE.test(patch[k])) throw new Error(`Invalid ${k}`);
      if (!Object.keys(patch).length) throw new Error("No updatable fields provided");
      patch.updated_at = now();
      const { data, error } = await sb.from("people").update(patch).eq("id", args.id).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Person not found");
      return { id: args.id, updated: Object.keys(patch).filter((k) => k !== "updated_at") };
    }

    case "set_do_not_contact": {
      if (!args.person_id) throw new Error("person_id required");
      const value = args.value !== false;
      const { error } = await sb.from("people").update({ do_not_contact: value, updated_at: now() } as any).eq("id", args.person_id);
      if (error) throw new Error(error.message);
      return { person_id: args.person_id, do_not_contact: value };
    }

    case "add_note": {
      const note = String(args.note ?? "").trim();
      if (!note) throw new Error("note required");
      let entityType = args.entity_type, entityId = args.entity_id;
      if (args.person_id) {
        entityId = args.person_id;
        const { data: p } = await sb.from("people").select("type").eq("id", args.person_id).maybeSingle();
        entityType = (p as any)?.type === "client" ? "contact" : "candidate";
      }
      if (!entityType || !entityId) throw new Error("Provide person_id, or entity_type + entity_id");
      return await addNote(sb, actor, entityType, entityId, note);
    }

    case "tag_person_to_job": {
      if (!args.candidate_id || !args.job_id) throw new Error("candidate_id and job_id required");
      const stage = PIPELINE_STAGES.includes(args.pipeline_stage) ? args.pipeline_stage : "new";
      const { data: ex } = await sb
        .from("candidate_jobs").select("id")
        .eq("candidate_id", args.candidate_id).eq("job_id", args.job_id).maybeSingle();
      if ((ex as any)?.id) return { candidate_job_id: (ex as any).id, duplicate: true };
      const { data, error } = await sb
        .from("candidate_jobs")
        .insert({ candidate_id: args.candidate_id, job_id: args.job_id, pipeline_stage: stage } as any)
        .select("id").single();
      if (error) throw new Error(error.message);
      return { candidate_job_id: (data as any).id };
    }

    case "set_pipeline_stage": {
      if (!args.candidate_id || !args.job_id || !args.pipeline_stage) throw new Error("candidate_id, job_id, pipeline_stage required");
      if (!PIPELINE_STAGES.includes(args.pipeline_stage)) throw new Error(`Invalid stage. Allowed: ${PIPELINE_STAGES.join(", ")}`);
      const { data: ex } = await sb
        .from("candidate_jobs").select("id")
        .eq("candidate_id", args.candidate_id).eq("job_id", args.job_id).maybeSingle();
      const patch: any = { pipeline_stage: args.pipeline_stage, stage_updated_at: now(), updated_at: now() };
      if ((ex as any)?.id) {
        const { error } = await sb.from("candidate_jobs").update(patch).eq("id", (ex as any).id);
        if (error) throw new Error(error.message);
        return { candidate_job_id: (ex as any).id, pipeline_stage: args.pipeline_stage };
      }
      const { data, error } = await sb
        .from("candidate_jobs")
        .insert({ candidate_id: args.candidate_id, job_id: args.job_id, ...patch } as any)
        .select("id").single();
      if (error) throw new Error(error.message);
      return { candidate_job_id: (data as any).id, pipeline_stage: args.pipeline_stage, created: true };
    }

    case "list_sequences": {
      const limit = clamp(args.limit, 25, 100);
      let q = sb
        .from("sequences")
        .select("id, name, status, audience_type, channel, job_id, created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (args.status) q = q.eq("status", args.status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data;
    }

    case "create_sequence": {
      if (!args.name) throw new Error("name required");
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (!steps.length) throw new Error("At least one step required");
      const audience = args.audience === "contacts" || args.audience === "clients" ? "contacts" : "candidates";
      const launch = args.launch === true;
      const seqPayload: any = {
        name: String(args.name),
        audience_type: audience,
        objective: args.objective ?? null,
        job_id: args.job_id ?? null,
        job_ids: args.job_id ? [args.job_id] : null,
        send_window_start: args.send_window_start ?? "09:00",
        send_window_end: args.send_window_end ?? "18:00",
        timezone: args.timezone ?? "America/New_York",
        weekdays_only: args.weekdays_only !== false,
        stop_on_reply: args.stop_on_reply !== false,
        created_by: actor.userId,
        sender_user_id: args.sender_user_id ?? actor.userId,
        status: launch ? "active" : "draft",
        engine: "inngest",
      };
      if (args.channel) seqPayload.channel = args.channel;
      const { data: seq, error: seqErr } = await sb.from("sequences").insert(seqPayload).select("id").single();
      if (seqErr) throw new Error(`Could not create sequence: ${seqErr.message}`);
      const sequenceId = (seq as any).id as string;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i] ?? {};
        const nodeId = randomUUID();
        const { error: ne } = await sb.from("sequence_nodes").insert({
          id: nodeId, sequence_id: sequenceId, node_order: i + 1, node_type: "action",
          label: s.label ?? `Step ${i + 1}`, branch_id: "branch_a", branch_step_order: i + 1,
        } as any);
        if (ne) throw new Error(`Step ${i + 1}: ${ne.message}`);
        const { error: ae } = await sb.from("sequence_actions").insert({
          id: randomUUID(), node_id: nodeId, channel: s.channel ?? "email",
          message_body: s.body ?? "", subject_line: s.subject ?? null,
          base_delay_hours: Number(s.delay_hours ?? (i === 0 ? 0 : 72)),
          jiggle_minutes: Number(s.jiggle_minutes ?? 15), use_signature: s.use_signature !== false,
          reply_to_previous: i > 0,
        } as any);
        if (ae) throw new Error(`Step ${i + 1} action: ${ae.message}`);
      }
      return {
        sequence_id: sequenceId,
        status: seqPayload.status,
        steps: steps.length,
        note: launch ? "Active. Call enroll_people to begin sends." : "Created as draft. Launch by enrolling people.",
      };
    }

    case "enroll_people": {
      if (!args.sequence_id) throw new Error("sequence_id required");
      const personIds: string[] = Array.isArray(args.person_ids)
        ? args.person_ids
        : args.person_id ? [args.person_id] : [];
      if (!personIds.length) throw new Error("person_ids required");
      const { data: seq } = await sb.from("sequences").select("id, audience_type, status").eq("id", args.sequence_id).maybeSingle();
      if (!seq) throw new Error("Sequence not found");
      const field = (seq as any).audience_type === "contacts" ? "contact_id" : "candidate_id";
      const { data: ppl } = await sb.from("people").select("id, do_not_contact").in("id", personIds);
      const dnc = new Set((ppl ?? []).filter((p: any) => p.do_not_contact).map((p: any) => p.id));
      const blocked = personIds.filter((id) => dnc.has(id));
      const eligible = personIds.filter((id) => !dnc.has(id));
      let already: string[] = [];
      if (eligible.length) {
        const { data: ex } = await sb
          .from("sequence_enrollments").select(`id, ${field}`)
          .eq("sequence_id", args.sequence_id).in(field, eligible).in("status", ["active", "paused"]);
        already = (ex ?? []).map((r: any) => r[field]);
      }
      const alreadySet = new Set(already);
      const toEnroll = eligible.filter((id) => !alreadySet.has(id));
      if (!toEnroll.length)
        return { enrolled: 0, blocked_do_not_contact: blocked, already_enrolled: already, message: "Nobody new to enroll." };
      const rows = toEnroll.map((id) => ({ sequence_id: args.sequence_id, [field]: id, status: "active", enrolled_by: actor.userId }));
      const { data: inserted, error } = await sb.from("sequence_enrollments").insert(rows as any).select(`id, sequence_id, ${field}`);
      if (error) throw new Error(error.message);
      const events = (inserted ?? []).map((r: any) => {
        const data: any = { enrollmentId: r.id, sequenceId: r.sequence_id, enrolledBy: actor.userId };
        if (field === "contact_id") data.contactId = r[field]; else data.candidateId = r[field];
        return { id: `enrollment-init-${r.id}`, name: "sequence/enrollment-init.requested" as const, data };
      });
      if (events.length) await inngest.send(events as any);
      return { enrolled: events.length, blocked_do_not_contact: blocked, already_enrolled: already };
    }

    case "set_enrollment_status": {
      if (!args.enrollment_id || !args.status) throw new Error("enrollment_id and status required");
      if (!["active", "paused", "stopped"].includes(args.status)) throw new Error("status must be active|paused|stopped");
      const patch: any = { status: args.status };
      if (args.status === "stopped") { patch.stopped_at = now(); patch.stop_reason = args.reason ?? "stopped via MCP"; }
      const { error } = await sb.from("sequence_enrollments").update(patch).eq("id", args.enrollment_id);
      if (error) throw new Error(error.message);
      return {
        enrollment_id: args.enrollment_id,
        status: args.status,
        ...(args.status === "active" ? { note: "Re-activated. Resuming does not re-schedule already-cancelled steps." } : {}),
      };
    }

    case "add_company": {
      const name = String(args.name ?? "").trim();
      if (!name) throw new Error("name required");
      const { data: existing } = await sb.from("companies").select("id, name").ilike("name", name).is("deleted_at", null).limit(1).maybeSingle();
      if ((existing as any)?.id) return { id: (existing as any).id, name: (existing as any).name, duplicate: true };
      const payload: any = {
        name,
        company_type: args.company_type ?? null,
        company_status: args.company_status ?? "target",
        industry: args.industry ?? null,
        location: args.location ?? null,
        hq_location: args.hq_location ?? null,
        domain: args.domain ?? null,
        website: args.website ?? null,
        linkedin_url: args.linkedin_url ?? null,
        description: args.description ?? null,
      };
      const { data, error } = await sb.from("companies").insert(payload).select("id").single();
      if (error) throw new Error(error.message);
      return { id: (data as any).id, name, duplicate: false };
    }

    case "update_company": {
      if (!args.id) throw new Error("id required");
      const fields = (args.fields ?? {}) as Record<string, any>;
      const allow = ["name", "company_type", "company_status", "industry", "location", "hq_location", "domain", "website", "linkedin_url", "description"];
      const patch: any = {};
      for (const k of allow) if (k in fields && fields[k] !== undefined) patch[k] = fields[k];
      if (!Object.keys(patch).length) throw new Error("No updatable fields provided");
      patch.updated_at = now();
      const { data, error } = await sb.from("companies").update(patch).eq("id", args.id).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Company not found");
      return { id: args.id, updated: Object.keys(patch).filter((k) => k !== "updated_at") };
    }

    case "add_job": {
      const title = String(args.title ?? "").trim();
      if (!title) throw new Error("title required");
      const jobUrl = args.job_url ? String(args.job_url).trim() : null;
      if (jobUrl) {
        const { data: dup } = await sb.from("jobs").select("id").eq("job_url", jobUrl).is("deleted_at", null).limit(1).maybeSingle();
        if ((dup as any)?.id) return { job_id: (dup as any).id, duplicate: true };
      }
      const companyText = (args.company ?? "").toString().trim() || null;
      let companyId: string | null = args.company_id ?? null;
      if (!companyId && companyText) {
        const { data: co } = await sb.from("companies").select("id").ilike("name", companyText).is("deleted_at", null).limit(1).maybeSingle();
        companyId = (co as any)?.id ?? null;
      }
      const jobStatus = ["lead", "hot", "closed_lost"].includes(args.status) ? args.status : "lead";
      const payload: any = {
        title,
        company_id: companyId,
        company_name: companyText,
        location: args.location?.trim() || null,
        description: args.description ?? null,
        compensation: args.compensation ?? null,
        num_openings: args.num_openings ?? null,
        submittal_instructions: args.submittal_instructions ?? null,
        additional_notes: args.additional_notes ?? null,
        job_url: jobUrl,
        status: jobStatus,
      };
      if (args.hiring_manager_id) payload.contact_id = args.hiring_manager_id;
      const { data: job, error } = await sb.from("jobs").insert(payload).select("id").single();
      if (error) throw new Error(error.message);
      const jobId = (job as any).id;
      if (args.hiring_manager_id) {
        const { error: jcErr } = await sb.from("job_contacts").insert({ job_id: jobId, contact_id: args.hiring_manager_id, is_primary: true, role: "Hiring Manager" } as any);
        if (jcErr && (jcErr as any).code !== "23505") throw new Error(jcErr.message);
      }
      return { job_id: jobId, company_id: companyId, status: jobStatus, hiring_manager_linked: !!args.hiring_manager_id };
    }

    case "update_job": {
      if (!args.id) throw new Error("id required");
      const fields = (args.fields ?? {}) as Record<string, any>;
      const allow = ["title", "status", "location", "description", "compensation", "num_openings", "company_id", "company_name", "contact_id", "submittal_instructions", "additional_notes", "job_url", "job_code"];
      const patch: any = {};
      for (const k of allow) if (k in fields && fields[k] !== undefined) patch[k] = fields[k];
      if ("status" in patch && !["lead", "hot", "closed_lost"].includes(patch.status)) throw new Error("Invalid status. Allowed: lead, hot, closed_lost");
      if (!Object.keys(patch).length) throw new Error("No updatable fields provided");
      patch.updated_at = now();
      const { data, error } = await sb.from("jobs").update(patch).eq("id", args.id).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Job not found");
      return { id: args.id, updated: Object.keys(patch).filter((k) => k !== "updated_at") };
    }

    case "add_job_contact": {
      if (!args.job_id || !args.person_id) throw new Error("job_id and person_id required");
      const row: any = { job_id: args.job_id, contact_id: args.person_id, is_primary: args.is_primary === true };
      if (args.role) row.role = String(args.role);
      const { error } = await sb.from("job_contacts").insert(row);
      const alreadyLinked = !!(error && (error as any).code === "23505");
      if (error && !alreadyLinked) throw new Error(error.message);
      if (args.is_primary === true) {
        await sb.from("jobs").update({ contact_id: args.person_id, updated_at: now() } as any).eq("id", args.job_id);
      }
      return { job_id: args.job_id, person_id: args.person_id, primary: args.is_primary === true, already_linked: alreadyLinked };
    }

    case "link_person_to_company": {
      if (!args.person_id) throw new Error("person_id required");
      let companyId: string | null = args.company_id ?? null;
      let companyName: string | null = args.company_name ? String(args.company_name).trim() : null;
      if (!companyId && companyName) {
        const { data: co } = await sb.from("companies").select("id, name").ilike("name", companyName).is("deleted_at", null).limit(1).maybeSingle();
        if ((co as any)?.id) { companyId = (co as any).id; companyName = (co as any).name; }
      }
      if (!companyId && !companyName) throw new Error("Provide company_id or company_name");
      const patch: any = { updated_at: now() };
      if (companyId) patch.company_id = companyId;
      if (companyName) patch.company_name = companyName;
      const { data, error } = await sb.from("people").update(patch).eq("id", args.person_id).select("id").maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("Person not found");
      return {
        person_id: args.person_id,
        company_id: companyId,
        company_name: companyName,
        linked: !!companyId,
        ...(companyId ? {} : { note: "No matching company found; saved company_name (auto-links if that company is later created)." }),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC + transport ──────────────────────────────────────────────────────
const ok = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: any, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function setCors(res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, accept, mcp-session-id, mcp-protocol-version");
}

function reply(req: VercelRequest, res: VercelResponse, body: any, status = 200) {
  setCors(res);
  const accept = String(req.headers.accept || "");
  if (accept.includes("text/event-stream")) {
    res.statusCode = status;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
    return res.end();
  }
  return res.status(status).json(body);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") { setCors(res); return res.status(204).end(); }
  if (req.method !== "POST") { setCors(res); return res.status(405).json({ error: "Method not allowed" }); }

  if (!SUPABASE_URL || !SERVICE_KEY) {
    setCors(res);
    return res.status(500).json(rpcErr(null, -32000, "Server misconfigured: missing Supabase credentials"));
  }
  // MCP discovery (initialize / tools/list / ping / notifications) is allowed
  // WITHOUT auth: ChatGPT lists a connector's tools BEFORE it sends the API
  // key, so 401-ing discovery makes the connector "fail to connect". Auth is
  // enforced per tool call below, where data is actually read/written.
  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const msg: any = req.body;
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    setCors(res);
    return res.status(400).json(rpcErr(null, -32600, "Invalid Request (expected a single JSON-RPC object)"));
  }

  const { id, method, params } = msg;
  // Notifications (no id) — acknowledge, no body.
  if (id === undefined || id === null) { setCors(res); return res.status(202).end(); }

  try {
    switch (method) {
      case "initialize":
        return reply(req, res, ok(id, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sully-recruit", version: "1.0.0" },
          instructions:
            "Sully Recruit CRM/ATS. People (candidates and/or clients) live in one table; person status is new|reached_out|engaged. Job status is lead|hot|closed_lost. Per-job pipeline stages: " +
            PIPELINE_STAGES.join(", ") +
            ". Use 'search' to find IDs. For anything the structured tools don't cover (counts, 'latest/most recent', filters, joins), call 'describe_schema' to learn exact columns then 'query' for read-only SQL. Outreach to do_not_contact people is blocked.",
        }));
      case "tools/list":
        return reply(req, res, ok(id, { tools: TOOLS }));
      case "tools/call": {
        const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const actor = bearer ? await resolveActor(sb, bearer) : null;
        if (!actor) {
          return reply(req, res, rpcErr(id, -32001, "Unauthorized: a valid per-user API token is required to run Sully Recruit tools."));
        }
        const out = await runTool(sb, actor, params?.name, params?.arguments ?? {});
        return reply(req, res, ok(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] }));
      }
      case "ping":
        return reply(req, res, ok(id, {}));
      default:
        return reply(req, res, rpcErr(id, -32601, `Method not found: ${method}`));
    }
  } catch (e: any) {
    // Tool failures come back as an isError result so the model can read them.
    return reply(req, res, ok(id, {
      content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
      isError: true,
    }));
  }
}
