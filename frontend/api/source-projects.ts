import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

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
 *   action: "list_projects" | "list_applicants" | "download_resume" | "list_accounts"
 *   account_id: Unipile account ID (required)
 *   job_id: project_id for list_applicants & download_resume
 *   applicant_id: required for download_resume
 *   cursor: optional offset (number) — name kept for back-compat
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

  const { action, account_id, job_id, applicant_id, cursor } = req.body || {};
  if (!action) return res.status(400).json({ error: "Missing action" });
  if (!account_id) return res.status(400).json({ error: "Missing account_id" });

  try {
    // Pull both base URLs. v2 is the canonical for new code; v1 stays
    // for action=list_accounts which still lives at /api/v1/accounts.
    const [{ data: v2Row }, { data: v1Row }, { data: keyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_V2_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").maybeSingle(),
    ]);

    const v2Base = (v2Row?.value || "").replace(/\/+$/, "")
      // Best-effort fallback: derive v2 from v1 (`/api/v1` → `/api/v2`)
      // when UNIPILE_BASE_V2_URL hasn't been set explicitly.
      || (v1Row?.value || "").replace(/\/+$/, "").replace(/\/api\/v1$/, "/api/v2");
    const v1Base = (v1Row?.value || "").replace(/\/+$/, "");
    const apiKey = keyRow?.value;

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
      const resp = await fetch(`${v1Base || v2Base.replace("/api/v2", "/api/v1")}/accounts`, { headers });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: (await resp.text()).slice(0, 500) });
      }
      return res.status(200).json(await resp.json());
    }

    // ── list_projects ─────────────────────────────────────────────
    // GET /v2/{account_id}/linkedin/recruiter/projects?limit=100&offset=0
    if (action === "list_projects") {
      const offset = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
      const url = `${v2Base}/${acct}/linkedin/recruiter/projects?limit=100&offset=${offset}`;
      const resp = await fetch(url, { headers });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: `Unipile ${resp.status}`, detail: (await resp.text()).slice(0, 500) });
      }
      const data = await resp.json();
      const items = data.items ?? data.results ?? data.projects ?? (Array.isArray(data) ? data : []);
      return res.status(200).json({ items, raw: data });
    }

    // ── list_applicants ──────────────────────────────────────────
    // 1. GET project for header info
    // 2. POST talent-pool/applicants (v2 expects POST + body, not GET)
    if (action === "list_applicants") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const projectId = encodeURIComponent(job_id);
      const tries: { url: string; method: string; status?: number; ok: boolean; count?: number; error?: string; keys?: string[] }[] = [];

      // 1) Project detail
      let projectData: any = null;
      const projectUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}`;
      try {
        const r = await fetch(projectUrl, { headers });
        const t: any = { url: projectUrl, method: "GET", status: r.status, ok: r.ok };
        if (r.ok) {
          projectData = await r.json();
          t.keys = projectData ? Object.keys(projectData).slice(0, 30) : [];
        } else {
          t.error = (await r.text()).slice(0, 500);
        }
        tries.push(t);
      } catch (err: any) {
        tries.push({ url: projectUrl, method: "GET", ok: false, error: err.message });
      }

      // 2) Applicants
      const offset = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
      const applicantsUrl = `${v2Base}/${acct}/linkedin/recruiter/projects/${projectId}/talent-pool/applicants`;
      let applicants: any[] = [];
      try {
        const r = await fetch(applicantsUrl, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 100, offset }),
        });
        const t: any = { url: applicantsUrl, method: "POST", status: r.status, ok: r.ok };
        if (r.ok) {
          const d = await r.json();
          applicants = d.items ?? d.results ?? d.applicants ?? d.candidates ?? (Array.isArray(d) ? d : []);
          t.count = applicants.length;
        } else {
          t.error = (await r.text()).slice(0, 500);
        }
        tries.push(t);
      } catch (err: any) {
        tries.push({ url: applicantsUrl, method: "POST", ok: false, error: err.message });
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
    // GET /v2/{account_id}/linkedin/recruiter/projects/{project_id}/talent-pool/applicants/{applicant_id}/resume
    if (action === "download_resume") {
      if (!job_id || !applicant_id) {
        return res.status(400).json({ error: "Missing job_id or applicant_id" });
      }
      const url =
        `${v2Base}/${acct}/linkedin/recruiter/projects/${encodeURIComponent(job_id)}` +
        `/talent-pool/applicants/${encodeURIComponent(applicant_id)}/resume`;
      const resp = await fetch(url, { headers });
      if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
      if (!resp.ok) {
        return res.status(resp.status).json({
          error: `Unipile ${resp.status}`,
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

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error("source-projects error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
