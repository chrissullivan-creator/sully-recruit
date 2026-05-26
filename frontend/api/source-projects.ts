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
    // v2 base URL + key for all Unipile calls.
    const [{ data: v2Row }, { data: v2KeyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY_V2").maybeSingle(),
    ]);

    const v2Base = (v2Row?.value || "").replace(/\/+$/, "") || "https://api.unipile.com/v2";
    const apiKey = v2KeyRow?.value;

    if (!v2Base || !apiKey) {
      return res.status(500).json({ error: "Unipile config missing (UNIPILE_BASE_V2_URL or UNIPILE_API_KEY_V2)" });
    }

    const headers: Record<string, string> = {
      "X-API-KEY": apiKey,
      Accept: "application/json",
    };
    const acct = encodeURIComponent(account_id);

    // ── list_accounts ─────────────────────────────────────────────
    // Diagnostic. v2: GET /v2/accounts (not account-scoped).
    if (action === "list_accounts") {
      const resp = await fetch(`${v2Base}/accounts`, { headers });
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
      // v2: GET /v2/{account_id}/linkedin/recruiter/projects
      const qs = new URLSearchParams();
      qs.set("sort_by", "ACCESSED_TIME");
      qs.set("sort_order", "DESCENDING");
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const url = `${v2Base}/${acct}/linkedin/recruiter/projects?${qs.toString()}`;
      const resp = await fetch(url, { headers });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      const body = await resp.text();
      if (resp.ok) {
        const data = JSON.parse(body);
        return res.status(200).json({
          items: data.items ?? data.data ?? [],
          raw: data,
          used_url: url,
          next_cursor: data.cursor ?? data.next_cursor ?? null,
          total_count: data?.paging?.total_count ?? data.total_count ?? null,
        });
      }
      // Persist the latest 4xx body to app_settings so it survives
      // Vercel's log preview truncation — query via the Supabase MCP
      // to read the full Unipile rejection text.
      console.error(`[source-projects][list_projects] Unipile ${resp.status} ${url} :: ${body.slice(0, 600)}`);
      await supabase.from("app_settings").upsert(
        { key: "DEBUG_UNIPILE_LIST_PROJECTS_LAST", value: JSON.stringify({ status: resp.status, url, body: body.slice(0, 2000), at: new Date().toISOString() }) },
        { onConflict: "key" },
      );
      return res.status(resp.status).json({
        error: `Unipile ${resp.status}`,
        url,
        body: body.slice(0, 1000),
      });
    }

    // list_applicants — deprecated. The UI moved to list_pipeline /
    // list_job_applicants which use confirmed v1 routes; this legacy
    // probe was the multi-URL guess against bogus v2 hosts.
    if (action === "list_applicants") {
      return res.status(410).json({
        error: "list_applicants is deprecated. Use list_pipeline or list_job_applicants.",
        items: [],
      });
    }

    // ── download_resume ──────────────────────────────────────────
    // v2: GET /v2/{account_id}/linkedin/jobs/{job_id}/applicants/{applicant_id}/resume
    // Note: job_id is required on v2. If not provided, fall back to applicant-only path.
    if (action === "download_resume") {
      if (!applicant_id) {
        return res.status(400).json({ error: "Missing applicant_id" });
      }
      const resumePath = job_id
        ? `${v2Base}/${acct}/linkedin/jobs/${encodeURIComponent(job_id)}/applicants/${encodeURIComponent(applicant_id)}/resume`
        : `${v2Base}/${acct}/linkedin/jobs/applicants/${encodeURIComponent(applicant_id)}/resume`;
      const url = resumePath;
      const resp = await fetch(url, { headers });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}: resume fetch failed`,
          detail: (await resp.text()).slice(0, 500),
        });
      }
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

    // ── create_project ──────────────────────────────────────────
    // POST /linkedin/recruiter/projects — body must include name + visibility.
    if (action === "create_project") {
      if (!name) return res.status(400).json({ error: "Missing name" });
      if (!visibility) return res.status(400).json({ error: "Missing visibility" });
      if (visibility !== "PRIVATE" && visibility !== "PUBLIC") {
        return res.status(400).json({ error: "visibility must be PRIVATE or PUBLIC" });
      }
      // No Unipile v1 endpoint for creating a Recruiter hiring project.
      // The v2 endpoint /v2/{acct}/linkedin/recruiter/projects POST exists
      // in the spec but our v2 app currently returns 403 for Recruiter
      // calls (Unipile-side scope gate — see Phase 2 plan).
      return res.status(501).json({
        error: "create_project is not available — Unipile has no v1 route for it and our v2 app lacks the Recruiter scope. Create the project in LinkedIn Recruiter UI and re-list.",
        name,
        visibility,
      });
    }

    // v2: GET /v2/{account_id}/linkedin/jobs/{job_id}/applicants/{applicant_id}
    if (action === "get_applicant") {
      if (!applicant_id) return res.status(400).json({ error: "Missing applicant_id" });
      const applicantPath = job_id
        ? `${v2Base}/${acct}/linkedin/jobs/${encodeURIComponent(job_id)}/applicants/${encodeURIComponent(applicant_id)}`
        : `${v2Base}/${acct}/linkedin/jobs/applicants/${encodeURIComponent(applicant_id)}`;
      const url = applicantPath;
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

    // save_candidate — pushes a candidate into a Recruiter project's
    // pipeline stage. No v1 endpoint exists for this; v2 has
    // /v2/{acct}/linkedin/recruiter/projects/{id}/pipeline/candidate/save
    // but our v2 app currently 403s on Recruiter scope (Phase 2 unblock).
    if (action === "save_candidate") {
      return res.status(501).json({
        error: "save_candidate is not available — no v1 route and v2 Recruiter scope is gated. Save via LinkedIn Recruiter UI for now.",
      });
    }

    // ── list_pipeline ───────────────────────────────────────────
    // POST /linkedin/recruiter/projects/{id}/pipeline — returns the
    // saved pipeline candidates (curated by the recruiter), grouped by
    // stage. Distinct from talent-pool/applicants (job posting applicants).
    // v1 doesn't expose a Recruiter "pipeline candidates" route — only
    // Talent Hub job applicants. So we read the project detail to get
    // the linked job_posting.id, then list applicants of that job.
    //   GET /v1/linkedin/projects/{id}?account_id=X
    //   GET /v1/linkedin/jobs/{job_posting_id}/applicants?account_id=X
    if (action === "list_pipeline") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const projectId = encodeURIComponent(job_id);

      // v2: GET /v2/{account_id}/linkedin/recruiter/projects/{id}
      const projUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}`;
      const projResp = await fetch(projUrl, { headers });
      if (projResp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      let projectData: any = null;
      if (projResp.ok) projectData = await projResp.json();

      const jobPostingId = projectData?.job_posting?.id;
      if (!jobPostingId) {
        return res.status(200).json({
          items: [],
          next_cursor: null,
          total_count: 0,
          project: projectData,
          note: "Project has no linked job_posting — no applicants to list",
        });
      }

      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const qsStr = qs.toString();
      // v2: POST /v2/{account_id}/linkedin/jobs/{job_id}/applicants
      const appUrl = `${v2Base}/${acct}/linkedin/jobs/${encodeURIComponent(jobPostingId)}/applicants${qsStr ? `?${qsStr}` : ""}`;
      const appResp = await fetch(appUrl, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({}) });
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
        items: appData?.items ?? appData?.data ?? [],
        next_cursor: appData?.cursor ?? appData?.next_cursor ?? null,
        total_count: appData?.paging?.total_count ?? appData?.total_count ?? null,
        project: projectData,
      });
    }

    // v2: GET /v2/{account_id}/linkedin/recruiter/projects/{id}
    //     POST /v2/{account_id}/linkedin/jobs/{job_posting_id}/applicants
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
      const jobPostingId = projectData?.job_posting?.id;
      if (!jobPostingId) {
        return res.status(200).json({
          items: [],
          project: projectData,
          next_cursor: null,
          total_count: 0,
          note: "Project has no linked job_posting — no applicants to list",
        });
      }

      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const qsStr2 = qs.toString();
      // v2: POST /v2/{account_id}/linkedin/jobs/{job_posting_id}/applicants
      const appUrl = `${v2Base}/${acct}/linkedin/jobs/${encodeURIComponent(jobPostingId)}/applicants${qsStr2 ? `?${qsStr2}` : ""}`;
      const appResp = await fetch(appUrl, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({}) });
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
        items: appData?.items ?? appData?.data ?? [],
        next_cursor: appData?.cursor ?? appData?.next_cursor ?? null,
        total_count: appData?.paging?.total_count ?? appData?.total_count ?? null,
        project: projectData,
        job_posting_id: jobPostingId,
      });
    }

    // v2: GET /v2/{account_id}/linkedin/recruiter/search-parameters
    if (action === "search_parameters") {
      if (!search || typeof search !== "object") {
        return res.status(400).json({ error: "Missing search body" });
      }
      const url = `${v2Base}/${acct}/linkedin/recruiter/search-parameters`;
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
        items: data?.items ?? data?.data ?? [],
        next_cursor: data?.cursor ?? data?.next_cursor ?? null,
        total_count: data?.paging?.total_count ?? data?.total_count ?? null,
        raw: data,
      });
    }

    // v2: POST /v2/{account_id}/linkedin/recruiter/search/candidates
    if (action === "search_people") {
      if (!search || typeof search !== "object") {
        return res.status(400).json({ error: "Missing search body" });
      }
      const qs = new URLSearchParams();
      if (cursor) qs.set("cursor", String(cursor));
      if (limit) qs.set("limit", String(limit));
      const qsStr3 = qs.toString();
      const url = `${v2Base}/${acct}/linkedin/recruiter/search/candidates${qsStr3 ? `?${qsStr3}` : ""}`;
      const body = { ...(search as Record<string, any>) };
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
          error: `Unipile ${resp.status}: search/people failed`,
          detail: data ?? text.slice(0, 500),
        });
      }
      return res.status(200).json({
        items: data?.items ?? data?.data ?? [],
        next_cursor: data?.cursor ?? data?.next_cursor ?? null,
        total_count: data?.paging?.total_count ?? data?.total_count ?? null,
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
      // Resolve the project's job_posting.id once via v1 project detail.
      // v1 doesn't expose a Recruiter "pipeline candidates" route, so the
      // `pipeline` source is currently a no-op (Phase 2: route via v2 once
      // Unipile enables the Recruiter scope on our v2 app).
      if (source === 'pipeline') {
        // v2 now supports pipeline candidates via recruiter projects
        // TODO: Implement pipeline candidate fetch when confirmed working
        return res.status(200).json({
          processed: 0, created: 0, updated: 0, errors: [],
          next_cursor: null, total_count: 0,
          note: 'pipeline candidates fetch via v2 pending implementation',
        });
      }

      // v2: GET /v2/{account_id}/linkedin/recruiter/projects/{id}
      const projResp = await fetch(
        `${v2Base}/${acct}/linkedin/recruiter/projects/${projId}`,
        { headers },
      );
      if (!projResp.ok) {
        return res.status(projResp.status).json({
          error: `Unipile ${projResp.status}: project fetch failed`,
          detail: (await projResp.text()).slice(0, 500),
        });
      }
      const projData = await projResp.json();
      const jobPostingId = projData?.job_posting?.id;
      if (!jobPostingId) {
        return res.status(200).json({
          processed: 0, created: 0, updated: 0, errors: [],
          next_cursor: null, total_count: 0,
          note: 'Project has no linked job_posting on Unipile',
        });
      }
      const qs = new URLSearchParams();
      qs.set('limit', String(batchLimit));
      if (cursor) qs.set('cursor', String(cursor));
      const qsBackfill = qs.toString();
      // v2: POST /v2/{account_id}/linkedin/jobs/{job_posting_id}/applicants
      const unipileUrl = `${v2Base}/${acct}/linkedin/jobs/${encodeURIComponent(jobPostingId)}/applicants${qsBackfill ? `?${qsBackfill}` : ""}`;

      const batchResp = await fetch(unipileUrl, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({}) });
      if (batchResp.status === 429) return res.status(429).json({ error: 'Unipile rate limit reached.' });
      if (!batchResp.ok) {
        return res.status(batchResp.status).json({
          error: `Unipile ${batchResp.status}: batch fetch failed`,
          detail: (await batchResp.text()).slice(0, 500),
        });
      }
      const batchData = await batchResp.json();
      const items: any[] = batchData?.items ?? batchData?.data ?? [];

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
        next_cursor: batchData?.cursor ?? batchData?.next_cursor ?? null,
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
