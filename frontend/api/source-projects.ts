import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

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
    // candidates under each project. We probe newest → oldest so we
    // keep working through Unipile path rollouts.
    if (action === "list_projects") {
      const offset = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
      const candidatePaths = [
        `linkedin/recruiter/hiring-projects`,
        `linkedin/hiring-projects`,
        `linkedin/recruiter/projects`,
      ];
      const tries: Array<{ url: string; status: number; ok: boolean; bodyPrefix?: string }> = [];
      for (const path of candidatePaths) {
        const url = `${v2Base}/${acct}/${path}?limit=100&offset=${offset}`;
        const resp = await fetch(url, { headers });
        if (resp.status === 429) return res.status(429).json({ error: "Unipile rate limit reached." });
        if (resp.ok) {
          const data = await resp.json();
          const items = data.items ?? data.results ?? data.projects ?? (Array.isArray(data) ? data : []);
          return res.status(200).json({ items, raw: data, used_path: path });
        }
        tries.push({ url, status: resp.status, ok: false, bodyPrefix: (await resp.text()).slice(0, 200) });
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
    // Path bases probed in order — same fallback logic as list_projects.
    if (action === "list_applicants") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });
      const projectId = encodeURIComponent(job_id);
      const projectBases = [
        `linkedin/recruiter/hiring-projects`,
        `linkedin/hiring-projects`,
        `linkedin/recruiter/projects`,
      ];
      const tries: { url: string; method: string; status?: number; ok: boolean; count?: number; error?: string; keys?: string[] }[] = [];

      // 1) Project detail
      let projectData: any = null;
      let workingBase: string | null = null;
      for (const base of projectBases) {
        const projectUrl = `${v2Base}/${acct}/${base}/${projectId}`;
        try {
          const r = await fetch(projectUrl, { headers });
          const t: any = { url: projectUrl, method: "GET", status: r.status, ok: r.ok };
          if (r.ok) {
            projectData = await r.json();
            t.keys = projectData ? Object.keys(projectData).slice(0, 30) : [];
            workingBase = base;
            tries.push(t);
            break;
          } else {
            t.error = (await r.text()).slice(0, 500);
          }
          tries.push(t);
        } catch (err: any) {
          tries.push({ url: projectUrl, method: "GET", ok: false, error: err.message });
        }
      }

      // 2) Candidates — try the new v2 GET pipeline-candidates path
      //    first (matches the docs reference `getrecruiterpipelinecandidates`),
      //    fall back to the legacy POST talent-pool/applicants for older
      //    Unipile builds.
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
          const applicantsUrl = `${v2Base}/${acct}/${base}/${projectId}/${v.suffix}`;
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
              applicants = d.items ?? d.results ?? d.applicants ?? d.candidates ?? (Array.isArray(d) ? d : []);
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

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err: any) {
    console.error("source-projects error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
