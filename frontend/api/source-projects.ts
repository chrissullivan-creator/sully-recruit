import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { classifyEmail, normalizeEmail } from "../src/lib/email-classifier.js";

// Map a LinkedIn recruiter pipeline stage name → our 4-stage sourcing
// funnel. LinkedIn lets recruiters customise stage labels, so the match
// is keyword-based rather than exact. Unmatched stages default to
// uncontacted (the safest starting point — auto-transitions will bump
// them as activity arrives).
function mapPipelineStage(rawStage?: string | null): 'uncontacted' | 'contacted' | 'replied' | 'back_of_resume' {
  const s = String(rawStage || '').toLowerCase();
  if (/phone|interview|screen|meeting|on[- ]?site|back[- ]?of[- ]?resume|hired|placed/.test(s)) return 'back_of_resume';
  if (/repl(y|ied)|respond|engaged|interest|accept/.test(s)) return 'replied';
  if (/contact|inmail|sent|outreach|reach|message/.test(s)) return 'contacted';
  return 'uncontacted';
}

// Pull a profile out of any of the three Unipile shapes (PipelineCandidate,
// JobApplicant, PeopleSearchResult) into a flat object the upsert below
// can consume directly.
function flattenProfile(raw: any) {
  const profile = raw?.profile && typeof raw.profile === 'object' ? raw.profile : raw;
  const work = (profile?.work_experience && profile.work_experience[0]) || {};
  const display: string = profile?.display_name
    || [profile?.first_name, profile?.last_name].filter(Boolean).join(' ')
    || '';
  const [firstFromDisplay, ...restFromDisplay] = display.split(/\s+/);
  return {
    raw,
    profile,
    candidate_id: profile?.candidate_id || profile?.id || raw?.id || null,
    first_name: profile?.first_name || firstFromDisplay || '',
    last_name: profile?.last_name || restFromDisplay.join(' ') || '',
    headline: profile?.headline || null,
    current_title: profile?.current_title || work?.job_title || profile?.headline || null,
    current_company: profile?.current_company || work?.company?.name || work?.company || null,
    location: profile?.location || null,
    linkedin_url: profile?.profile_url || profile?.linkedin_url || null,
    avatar_url: profile?.public_picture_url || profile?.profile_picture_url || null,
    email: Array.isArray(profile?.emails) ? profile.emails[0] : profile?.email || null,
    phone: Array.isArray(profile?.phone_numbers) ? profile.phone_numbers[0] : profile?.phone || null,
    pipeline_stage: raw?.hiring_project?.pipeline_stage || profile?.hiring_project?.pipeline_stage || null,
    has_resume: raw?.has_resume === true,
  };
}

// Bumped 2026-05-08 to force Vercel to rebuild this serverless function.
// Production was returning 404 even though the file was on main; build
// log didn't surface a per-function error. Touching the file to invalidate
// any stale cache and confirm the deploy actually picks it up.

/**
 * POST /api/source-projects
 *
 * Proxies Unipile **v2** LinkedIn Recruiter hiring-project calls.
 * v1 was retired for these endpoints — see Unipile's migration guide:
 *   https://developer.unipile.com/v2.0/docs/migration-linkedin-api
 *
 * Key v2 differences:
 *   - account_id MUST be in the path, no longer a query/body param.
 *   - Hiring projects: /v2/{account_id}/linkedin/recruiter/projects[/{id}]
 *   - Candidates in a project (talent-pool applicants): POST not GET,
 *     filters in the body, path is
 *     /v2/{account_id}/linkedin/recruiter/projects/{id}/talent-pool/applicants
 *   - Applicant resume: GET …/talent-pool/applicants/{applicant_id}/resume
 *
 * Body: { action, account_id, ...params }
 *   action: "list_projects" | "list_applicants" | "list_pipeline"
 *         | "list_job_applicants" | "download_resume" | "list_accounts"
 *         | "create_project" | "get_applicant" | "save_candidate"
 *         | "search_parameters" | "search_people"
 *
 *   NOTE on list actions: legacy `list_applicants` probes several Unipile
 *   path shapes and returns whichever data layer responded first (usually
 *   pipeline-candidates). New code should call `list_pipeline` (curated
 *   pipeline) or `list_job_applicants` (job posting applicants) explicitly.
 *   account_id: Unipile account ID (required)
 *   job_id: project_id for list_applicants, download_resume, get_applicant, save_candidate
 *   applicant_id: required for download_resume, get_applicant
 *   cursor: pagination cursor (or numeric offset for legacy list endpoints)
 *   create_project: { name, visibility ("PRIVATE"|"PUBLIC"), description?, company?, job_title?, location?, seniority_level? }
 *   save_candidate: { stage_id, candidate_id }
 *   search_parameters / search_people: { search: <Unipile body>, limit?, cursor? }
 *
 * Auth: Supabase JWT
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  // Auth
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  const {
    action,
    account_id,
    job_id,
    applicant_id,
    cursor,
    // create_project
    name,
    visibility,
    description,
    company,
    job_title,
    location,
    seniority_level,
    // save_candidate
    stage_id,
    candidate_id,
    // search_parameters / search_people
    search,        // body for /search/parameters OR /search/people
    limit,         // optional, both endpoints
  } = req.body || {};
  if (!action) return res.status(400).json({ error: "Missing action" });
  if (!account_id) return res.status(400).json({ error: "Missing account_id" });

  try {
    // Pull both base URLs + both keys. v2 is the canonical for new code;
    // v1 stays for action=list_accounts and for message/send routes that
    // haven't migrated. Prefer the v2-specific key (UNIPILE_API_KEY_V2)
    // when set, fall back to UNIPILE_API_KEY otherwise. Same single key
    // is fine for both products in most Unipile setups.
    const [{ data: v2Row }, { data: v1Row }, { data: v2KeyRow }, { data: v1KeyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
    ]);

    const v2Base = (v2Row?.value || "").replace(/\/+$/, "")
      || "https://api.unipile.com/v2";
    const v1Base = (v1Row?.value || "").replace(/\/+$/, "");
    const apiKey = v2KeyRow?.value || v1KeyRow?.value;

    if (!v2Base || !apiKey) {
      return res.status(500).json({ error: "Unipile config missing (UNIPILE_BASE_V2_URL or UNIPILE_API_KEY)" });
    }

    const headers: Record<string, string> = {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    };
    const acct = encodeURIComponent(account_id);

    // ── list_accounts ─────────────────────────────────────────────
    // Diagnostic. Still on v1 — Unipile's account routes haven't moved.
    if (action === "list_accounts") {
      // v1 still serves the diagnostic /accounts route; fall back to the
      // dedicated DSN if the v1 setting was unset.
      const v1FromDsn = "https://api19.unipile.com:14926/api/v1";
      const resp = await fetch(`${v1Base || v1FromDsn}/accounts`, { headers });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: (await resp.text()).slice(0, 500) });
      }
      return res.status(200).json(await resp.json());
    }

    // ── list_projects ─────────────────────────────────────────────
    // Unipile v2 path probe — the docs name the controller "recruiter"
    // and the action "hiringProjectList" / "pipelineCandidates" /
    // "hiringProject" (createrecruiterhiringproject), so the canonical
    // path is /linkedin/recruiter/hiring-projects with pipeline-
    // candidates under each project. We probe a few candidate paths
    // in case Unipile renames or sticks to legacy names.
    if (action === "list_projects") {
      const offset = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
      const candidatePaths = [
        `linkedin/recruiter/hiring-projects`,
        `linkedin/hiring-projects`,
        `linkedin/recruiter/projects`,
      ];
      const tries: Array<{ url: string; status: number; ok: boolean; bodyPrefix?: string }> = [];
      // Per Unipile v2 docs every endpoint puts account_id in the path.
      // Top-level (?account_id=…) kept as a fallback for builds where
      // hiring projects surface under a different shape.
      for (const path of candidatePaths) {
        const variants = [
          `${v2Base}/${acct}/${path}?limit=100&offset=${offset}`,
          `${v2Base}/${path}?account_id=${acct}&limit=100&offset=${offset}`,
        ];
        for (const url of variants) {
          const resp = await fetch(url, { headers });
          if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
          if (resp.ok) {
            const data = await resp.json();
            // Unipile v2 wraps lists in `data`. Keep the legacy keys as
            // fallbacks so a v1 leak (or a future rename) doesn't break us.
            const items = data.data ?? data.items ?? data.results ?? data.projects ?? (Array.isArray(data) ? data : []);
            return res.status(200).json({
              items,
              raw: data,
              used_path: path,
              used_url: url,
              next_cursor: data.next_cursor ?? null,
              total_count: data.total_count ?? null,
            });
          }
          tries.push({ url, status: resp.status, ok: false, bodyPrefix: (await resp.text()).slice(0, 200) });
        }
      }
      // None worked — return the LAST status so the UI surfaces a real error.
      const last = tries[tries.length - 1];
      return res.status(last?.status || 500).json({
        error: `Unipile ${last?.status}: hiring projects endpoint not found`,
        detail: tries,
      });
    }

    // ── list_applicants ──────────────────────────────────────────
    // 1. GET project for header info
    // 2. POST talent-pool/applicants (v2 expects POST + body, not GET)
    // Path bases probed in order, each tried both top-level and
    // path-segmented (mirrors list_projects probe).
    if (action === "list_applicants") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const projectId = encodeURIComponent(job_id);
      const projectBases = [
        `linkedin/recruiter/hiring-projects`,
        `linkedin/hiring-projects`,
        `linkedin/recruiter/projects`,
      ];
      const tries: { url: string; method: string; status?: number; ok: boolean; count?: number; error?: string; keys?: string[] }[] = [];

      // Helper: build both URL shapes for a project-scoped path
      // (path-segmented first per Unipile v2 docs, top-level as fallback).
      const buildVariants = (base: string, suffix: string) => {
        const root = suffix ? `${base}/${projectId}/${suffix}` : `${base}/${projectId}`;
        return [
          `${v2Base}/${acct}/${root}`,
          `${v2Base}/${root}${root.includes("?") ? "&" : "?"}account_id=${acct}`,
        ];
      };

      // 1) Project detail
      let projectData: any = null;
      let workingBase: string | null = null;
      let workingShape: "topLevel" | "pathSeg" | null = null;
      outerProj: for (const base of projectBases) {
        const urls = buildVariants(base, "");
        for (let i = 0; i < urls.length; i++) {
          const projectUrl = urls[i];
          try {
            const r = await fetch(projectUrl, { headers });
            const t: any = { url: projectUrl, method: "GET", status: r.status, ok: r.ok };
            if (r.ok) {
              projectData = await r.json();
              t.keys = projectData ? Object.keys(projectData).slice(0, 30) : [];
              workingBase = base;
              workingShape = i === 0 ? "topLevel" : "pathSeg";
              tries.push(t);
              break outerProj;
            } else {
              t.error = (await r.text()).slice(0, 500);
            }
            tries.push(t);
          } catch (err: any) {
            tries.push({ url: projectUrl, method: "GET", ok: false, error: err.message });
          }
        }
      }

      // 2) Candidates — try GET pipeline-candidates first, fall back to
      //    POST talent-pool/applicants for older Unipile builds.
      const applicantBases = workingBase ? [workingBase] : projectBases;
      const offset = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
      const variants: Array<{
        suffix: string;
        method: "GET" | "POST";
        body?: string;
      }> = [
        { suffix: `pipeline-candidates?limit=100&offset=${offset}`, method: "GET" },
        {
          suffix: `talent-pool/applicants`,
          method: "POST",
          body: JSON.stringify({ limit: 100, offset }),
        },
      ];
      let applicants: any[] = [];
      outer: for (const base of applicantBases) {
        for (const v of variants) {
          // If we already know the shape from step 1, only try that one.
          const allUrls = buildVariants(base, v.suffix);
          const urls = workingShape === "topLevel" ? [allUrls[0]]
            : workingShape === "pathSeg" ? [allUrls[1]]
            : allUrls;
          for (const applicantsUrl of urls) {
            try {
              const r = await fetch(applicantsUrl, {
                method: v.method,
                headers: v.method === "POST"
                  ? { ...headers, "Content-Type": "application/json" }
                  : headers,
                body: v.body,
              });
              const t: any = { url: applicantsUrl, method: v.method, status: r.status, ok: r.ok };
              if (r.ok) {
                const d = await r.json();
                applicants = d.data ?? d.items ?? d.results ?? d.applicants ?? d.candidates ?? (Array.isArray(d) ? d : []);
                t.count = applicants.length;
                workingBase = base;
                tries.push(t);
                break outer;
              } else {
                t.error = (await r.text()).slice(0, 500);
              }
              tries.push(t);
            } catch (err: any) {
              tries.push({ url: applicantsUrl, method: v.method, ok: false, error: err.message });
            }
          }
        }
      }

      // Normalise stage values: v2 uses `pipeline_stage`. Keep the
      // legacy fallbacks so older v1 responses still work if they
      // somehow leak through.
      applicants = applicants.map((a: any) => {
        const rawStage = String(
          a.pipeline_stage ?? a.stage ?? a.status ?? a.recruiter_pipeline_category ?? "unknown",
        ).toLowerCase().replace(/_/g, " ");
        let stage = "unknown";
        if (rawStage.includes("applied") || rawStage.includes("new") || rawStage.includes("uncontact")) stage = "uncontacted";
        else if (rawStage.includes("contact") || rawStage.includes("reach") || rawStage.includes("sent") || rawStage.includes("inmail")) stage = "contacted";
        else if (rawStage.includes("reply") || rawStage.includes("respond") || rawStage.includes("interest")) stage = "replied";
        else if (rawStage.includes("screen") || rawStage.includes("interview") || rawStage.includes("review")) stage = "in_review";
        else if (rawStage.includes("offer")) stage = "offer";
        else if (rawStage.includes("hired") || rawStage.includes("place")) stage = "hired";
        else if (rawStage.includes("reject") || rawStage.includes("decline") || rawStage.includes("withdrawn")) stage = "rejected";
        return { ...a, stage };
      });

      return res.status(200).json({
        items: applicants,
        project: projectData,
        debug: applicants.length === 0 ? { tries } : undefined,
      });
    }

    // ── download_resume ──────────────────────────────────────────
    // Try both v2 path bases in order, same as list_*.
    if (action === "download_resume") {
      if (!job_id || !applicant_id) {
        return res.status(400).json({ error: "Missing job_id or applicant_id" });
      }
      const projectBases = [
        `linkedin/recruiter/hiring-projects`,
        `linkedin/hiring-projects`,
        `linkedin/recruiter/projects`,
      ];
      const tries: Array<{ url: string; status: number; bodyPrefix?: string }> = [];
      for (const base of projectBases) {
        const url =
          `${v2Base}/${acct}/${base}/${encodeURIComponent(job_id)}` +
          `/talent-pool/applicants/${encodeURIComponent(applicant_id)}/resume`;
        const resp = await fetch(url, { headers });
        if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
        if (resp.ok) {
          const contentType = resp.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            return res.status(200).json(await resp.json());
          }
          const buffer = Buffer.from(await resp.arrayBuffer());
          return res.status(200).json({
            content_type: contentType || "application/pdf",
            data_base64: buffer.toString("base64"),
            size_bytes: buffer.length,
          });
        }
        tries.push({ url, status: resp.status, bodyPrefix: (await resp.text()).slice(0, 200) });
      }
      const last = tries[tries.length - 1];
      return res.status(last?.status || 500).json({
        error: `Unipile ${last?.status}: resume endpoint not found`,
        detail: tries,
      });
    }

    // ── create_project ──────────────────────────────────────────
    // POST /linkedin/recruiter/projects — body must include name + visibility.
    if (action === "create_project") {
      if (!name) return res.status(400).json({ error: "Missing name" });
      if (!visibility) return res.status(400).json({ error: "Missing visibility" });
      if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
        return res.status(400).json({ error: "visibility must be PRIVATE or PUBLIC" });
      }
      const body: Record<string, any> = { name, visibility };
      if (description) body.description = description;
      if (company) body.company = company;
      if (job_title) body.job_title = job_title;
      if (location) body.location = location;
      if (seniority_level) body.seniority_level = seniority_level;
      const url = `${v2Base}/${acct}/linkedin/recruiter/projects`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}: failed to create project`,
          detail: data ?? text.slice(0, 500),
        });
      }
      return res.status(201).json(data);
    }

    // ── get_applicant ───────────────────────────────────────────
    // GET /linkedin/recruiter/projects/{id}/talent-pool/applicants/{aid}
    if (action === "get_applicant") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      if (!applicant_id) return res.status(400).json({ error: "Missing applicant_id" });
      const url = `${v2Base}/${acct}/linkedin/recruiter/projects/`
        + `${encodeURIComponent(job_id)}/talent-pool/applicants/`
        + `${encodeURIComponent(applicant_id)}`;
      const resp = await fetch(url, { headers });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}: failed to get applicant`,
          detail: data ?? text.slice(0, 500),
        });
      }
      return res.status(200).json(data);
    }

    // ── save_candidate ──────────────────────────────────────────
    // POST /linkedin/recruiter/projects/{id}/pipeline/candidate/save
    if (action === "save_candidate") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      if (!stage_id) return res.status(400).json({ error: "Missing stage_id" });
      if (!candidate_id) return res.status(400).json({ error: "Missing candidate_id" });
      const url = `${v2Base}/${acct}/linkedin/recruiter/projects/`
        + `${encodeURIComponent(job_id)}/pipeline/candidate/save`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ stage_id, candidate_id }),
      });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}: failed to save candidate`,
          detail: data ?? text.slice(0, 500),
        });
      }
      return res.status(200).json(data);
    }

    // ── list_pipeline ───────────────────────────────────────────
    // POST /linkedin/recruiter/projects/{id}/pipeline — returns the
    // saved pipeline candidates (curated by the recruiter), grouped by
    // stage. Distinct from talent-pool/applicants (job posting applicants).
    if (action === "list_pipeline") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const projectId = encodeURIComponent(job_id);

      // Project detail first so the UI has header info + the pipeline
      // stage definitions.
      const projUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}`;
      const projResp = await fetch(projUrl, { headers });
      if (projResp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      let projectData: any = null;
      if (projResp.ok) projectData = await projResp.json();

      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const qsStr = qs.toString();
      const pipeUrl =
        `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}/pipeline` +
        (qsStr ? `?${qsStr}` : "");
      const pipeBody: Record<string, any> = {};
      if (search && typeof search === "object") Object.assign(pipeBody, search);
      const pipeResp = await fetch(pipeUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(pipeBody),
      });
      if (pipeResp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const pipeText = await pipeResp.text();
      const pipeData = pipeText ? JSON.parse(pipeText) : null;
      if (!pipeResp.ok) {
        return res.status(pipeResp.status).json({
          error: `Unipile ${pipeResp.status}: pipeline fetch failed`,
          detail: pipeData ?? pipeText.slice(0, 500),
        });
      }
      return res.status(200).json({
        items: pipeData?.data ?? [],
        next_cursor: pipeData?.next_cursor ?? null,
        total_count: pipeData?.total_count ?? null,
        project: projectData,
      });
    }

    // ── list_job_applicants ─────────────────────────────────────
    // POST /linkedin/recruiter/projects/{id}/talent-pool/applicants
    // Requires the JOB_POSTING channel_id (resolved from project detail).
    // Defaults to NEWEST_FIRST so the UI can render an "applied today / yesterday" feed.
    if (action === "list_job_applicants") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const projectId = encodeURIComponent(job_id);

      const projUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}`;
      const projResp = await fetch(projUrl, { headers });
      if (projResp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      if (!projResp.ok) {
        return res.status(projResp.status).json({
          error: `Unipile ${projResp.status}: project fetch failed`,
          detail: (await projResp.text()).slice(0, 500),
        });
      }
      const projectData = await projResp.json();
      const channels: any[] = projectData?.talent_pool?.channels || [];
      const jobChannel = channels.find((c) => c?.type === "JOB_POSTING");
      if (!jobChannel?.id) {
        // No linked job posting — return empty applicants instead of an error.
        return res.status(200).json({
          items: [],
          project: projectData,
          next_cursor: null,
          total_count: 0,
          note: "No JOB_POSTING channel on this project",
        });
      }

      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const qsStr = qs.toString();
      const appUrl =
        `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}/talent-pool/applicants` +
        (qsStr ? `?${qsStr}` : "");
      const appBody: Record<string, any> = {
        channel_id: jobChannel.id,
        sort_by: "NEWEST_FIRST",
      };
      if (search && typeof search === "object") Object.assign(appBody, search);
      const appResp = await fetch(appUrl, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(appBody),
      });
      if (appResp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const appText = await appResp.text();
      const appData = appText ? JSON.parse(appText) : null;
      if (!appResp.ok) {
        return res.status(appResp.status).json({
          error: `Unipile ${appResp.status}: applicants fetch failed`,
          detail: appData ?? appText.slice(0, 500),
        });
      }
      return res.status(200).json({
        items: appData?.data ?? [],
        next_cursor: appData?.next_cursor ?? null,
        total_count: appData?.total_count ?? null,
        project: projectData,
        channel_id: jobChannel.id,
      });
    }

    // ── search_parameters ───────────────────────────────────────
    // POST /linkedin/recruiter/search/parameters — pass through the
    // caller-supplied body (source/type/keywords/project_id/etc).
    if (action === "search_parameters") {
      if (!search || typeof search !== "object") {
        return res.status(400).json({ error: "Missing search body" });
      }
      const url = `${v2Base}/${acct}/linkedin/recruiter/search/parameters`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(search),
      });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}: search/parameters failed`,
          detail: data ?? text.slice(0, 500),
        });
      }
      return res.status(200).json({
        items: data?.data ?? [],
        next_cursor: data?.next_cursor ?? null,
        total_count: data?.total_count ?? null,
        raw: data,
      });
    }

    // ── search_people ───────────────────────────────────────────
    // POST /linkedin/recruiter/search/people — filters in body.
    // Supports cursor pagination via ?cursor=… and ?limit=…
    if (action === "search_people") {
      if (!search || typeof search !== "object") {
        return res.status(400).json({ error: "Missing search body" });
      }
      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const qsStr = qs.toString();
      const url =
        `${v2Base}/${acct}/linkedin/recruiter/search/people` +
        (qsStr ? `?${qsStr}` : "");
      const resp = await fetch(url, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(search),
      });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const text = await resp.text();
      const data = text ? JSON.parse(text) : null;
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}: search/people failed`,
          detail: data ?? text.slice(0, 500),
        });
      }
      return res.status(200).json({
        items: data?.data ?? [],
        next_cursor: data?.next_cursor ?? null,
        total_count: data?.total_count ?? null,
        raw: data,
      });
    }

    // ── backfill_project ────────────────────────────────────────
    // Imports one batch of candidates from a LinkedIn project into our
    // DB: upserts people + sourcing rows. The Unipile pipeline call
    // already happened (these candidates ARE in the LinkedIn pipeline);
    // we just mirror them locally.
    //
    // Body: { account_id, job_id (= project_id), source ('pipeline' | 'applicants'),
    //         cursor?, limit? (default 25), internal_job_id? }
    // Returns: { processed, created, updated, errors[], next_cursor, total_count }
    //
    // Caller loops while next_cursor is non-null to process the whole project.
    if (action === "backfill_project") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const source = (req.body?.source || 'pipeline') as 'pipeline' | 'applicants';
      const batchLimit = Number(req.body?.limit) || 25;
      const internalJobIdOverride = req.body?.internal_job_id || null;

      // Resolve internal job from the link columns (or use override).
      let internalJobId: string | null = internalJobIdOverride;
      if (!internalJobId) {
        const { data: linked } = await supabase
          .from("jobs")
          .select("id")
          .eq("linkedin_project_id", job_id)
          .eq("linkedin_project_account_id", account_id)
          .maybeSingle();
        if (!linked?.id) {
          return res.status(409).json({
            error: "No internal job linked to this LinkedIn project. Link first.",
            code: "PROJECT_NOT_LINKED",
          });
        }
        internalJobId = linked.id;
      }

      // Fetch the batch.
      const projId = encodeURIComponent(job_id);
      let unipileUrl: string;
      let unipileBody: Record<string, any>;
      if (source === 'pipeline') {
        const qs = new URLSearchParams();
        if (cursor) qs.set('cursor', String(cursor));
        qs.set('limit', String(batchLimit));
        unipileUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projId}/pipeline?${qs}`;
        unipileBody = {};
      } else {
        // talent-pool/applicants requires JOB_POSTING channel_id — fetch
        // project detail first to pick it up.
        const projResp = await fetch(`${v2Base}/${acct}/linkedin/recruiter/projects/${projId}`, { headers });
        if (!projResp.ok) {
          return res.status(projResp.status).json({
            error: `Unipile ${projResp.status}: project fetch failed`,
            detail: (await projResp.text()).slice(0, 500),
          });
        }
        const projData = await projResp.json();
        const ch = (projData?.talent_pool?.channels || []).find((c: any) => c?.type === 'JOB_POSTING');
        if (!ch?.id) {
          // No applicants channel — nothing to do for this source.
          return res.status(200).json({
            processed: 0, created: 0, updated: 0, errors: [],
            next_cursor: null, total_count: 0,
            note: 'No JOB_POSTING channel on this project',
          });
        }
        const qs = new URLSearchParams();
        if (cursor) qs.set('cursor', String(cursor));
        qs.set('limit', String(batchLimit));
        unipileUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projId}/talent-pool/applicants?${qs}`;
        unipileBody = { channel_id: ch.id, sort_by: 'NEWEST_FIRST' };
      }

      const batchResp = await fetch(unipileUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(unipileBody),
      });
      if (batchResp.status === 429) return res.status(429).json({ error: 'Unipile rate limit reached.' });
      if (!batchResp.ok) {
        return res.status(batchResp.status).json({
          error: `Unipile ${batchResp.status}: batch fetch failed`,
          detail: (await batchResp.text()).slice(0, 500),
        });
      }
      const batchData = await batchResp.json();
      const items: any[] = batchData?.data ?? [];

      let created = 0;
      let updated = 0;
      const errors: any[] = [];

      for (const raw of items) {
        try {
          const p = flattenProfile(raw);
          const incomingEmail = normalizeEmail(p.email);
          const incomingPhone = p.phone || null;
          const stage = source === 'pipeline'
            ? mapPipelineStage(p.pipeline_stage)
            : 'uncontacted'; // applicants are pre-outreach by definition

          // Dedupe (mirrors save-to-pipeline policy).
          let existing: any = null;
          if (p.linkedin_url) {
            const { data } = await supabase
              .from('people')
              .select('id, personal_email, work_email, primary_email, phone, mobile_phone')
              .eq('linkedin_url', p.linkedin_url)
              .maybeSingle();
            if (data?.id) existing = data;
          }
          if (!existing && incomingEmail) {
            const { data } = await supabase
              .from('people')
              .select('id, personal_email, work_email, primary_email, phone, mobile_phone')
              .or(
                `personal_email.ilike.${incomingEmail},work_email.ilike.${incomingEmail},primary_email.ilike.${incomingEmail}`,
              )
              .limit(1)
              .maybeSingle();
            if (data?.id) existing = data;
          }

          let personId: string;
          if (existing?.id) {
            personId = existing.id;
            const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null;
            const updates: Record<string, any> = {
              first_name: p.first_name || undefined,
              last_name: p.last_name || undefined,
              full_name: fullName || undefined,
              linkedin_url: p.linkedin_url || undefined,
              linkedin_headline: p.headline,
              linkedin_current_title: p.current_title,
              linkedin_current_company: p.current_company,
              linkedin_location: p.location,
              linkedin_last_synced_at: new Date().toISOString(),
              current_title: p.current_title || undefined,
              current_company: p.current_company || undefined,
              location_text: p.location || undefined,
              avatar_url: p.avatar_url || undefined,
              updated_at: new Date().toISOString(),
            };
            Object.keys(updates).forEach((k) => updates[k] === undefined && delete updates[k]);
            if (incomingEmail && !existing.personal_email && !existing.work_email && !existing.primary_email) {
              Object.assign(updates, classifyEmail(incomingEmail));
            }
            if (incomingPhone && !existing.phone && !existing.mobile_phone) {
              updates.phone = incomingPhone;
              updates.mobile_phone = incomingPhone;
            }
            await supabase.from('people').update(updates as any).eq('id', personId);
            updated += 1;
          } else {
            const fullName = [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || null;
            const payload: Record<string, any> = {
              first_name: p.first_name || null,
              last_name: p.last_name || null,
              full_name: fullName,
              linkedin_url: p.linkedin_url,
              linkedin_headline: p.headline,
              linkedin_current_title: p.current_title,
              linkedin_current_company: p.current_company,
              linkedin_location: p.location,
              linkedin_last_synced_at: new Date().toISOString(),
              current_title: p.current_title,
              current_company: p.current_company,
              location_text: p.location,
              avatar_url: p.avatar_url,
              type: 'candidate',
              roles: ['candidate'],
              status: 'new',
              is_stub: false,
              source: source === 'pipeline' ? 'linkedin_hiring_project_backfill' : 'linkedin_job_applicant_backfill',
              source_detail: job_id,
              owner_user_id: user.id,
              created_by_user_id: user.id,
              unipile_resolve_status: p.linkedin_url ? 'pending' : null,
            };
            if (incomingEmail) Object.assign(payload, classifyEmail(incomingEmail));
            if (incomingPhone) {
              payload.phone = incomingPhone;
              payload.mobile_phone = incomingPhone;
            }
            const { data: row, error: insErr } = await supabase
              .from('people')
              .insert(payload as any)
              .select('id')
              .single();
            if (insErr || !row) throw insErr || new Error('insert returned no row');
            personId = row.id;
            created += 1;
          }

          // Upsert sourcing row at the mapped stage. The stage timestamp
          // is set to the project's last_modified_at if available so
          // backfilled rows look chronologically reasonable.
          const stageColumn = `${stage}_at`;
          const stampAt = batchData?.last_modified_at || new Date().toISOString();
          const sourcingPayload: Record<string, any> = {
            candidate_id: personId,
            job_id: internalJobId,
            stage,
            linkedin_project_id: job_id,
            linkedin_project_account_id: account_id,
            created_by: user.id,
            [stageColumn]: stampAt,
          };
          // For non-uncontacted stages, backfill the earlier timestamps so
          // the funnel reads forward (uncontacted_at <= contacted_at <= …).
          if (stage === 'contacted' || stage === 'replied' || stage === 'back_of_resume') {
            sourcingPayload.uncontacted_at = sourcingPayload.uncontacted_at ?? stampAt;
          }
          if (stage === 'replied' || stage === 'back_of_resume') {
            sourcingPayload.contacted_at = sourcingPayload.contacted_at ?? stampAt;
          }
          if (stage === 'back_of_resume') {
            sourcingPayload.replied_at = sourcingPayload.replied_at ?? stampAt;
          }
          await supabase.from('sourcing').upsert(
            sourcingPayload as any,
            { onConflict: 'candidate_id,job_id', ignoreDuplicates: false },
          );
        } catch (err: any) {
          errors.push({ id: raw?.id || raw?.profile?.id, message: err?.message || String(err) });
        }
      }

      return res.status(200).json({
        processed: items.length,
        created,
        updated,
        errors,
        next_cursor: batchData?.next_cursor ?? null,
        total_count: batchData?.total_count ?? null,
        source,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error("source-projects error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
