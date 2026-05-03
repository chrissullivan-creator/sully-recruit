import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/source-projects
 *
 * Proxies Unipile LinkedIn Recruiter hiring-project API calls.
 *
 * Body: { action, account_id, ...params }
 *   action: "list_projects" | "list_applicants" | "download_resume"
 *   account_id: Unipile account ID (required)
 *   job_id: required for list_applicants & download_resume
 *   applicant_id: required for download_resume
 *   cursor: optional pagination cursor
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
    // Get Unipile config from app_settings
    const [{ data: urlRow }, { data: keyRow }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_BASE_URL").single(),
      supabase.from("app_settings").select("value").eq("key", "UNIPILE_API_KEY").single(),
    ]);

    const baseUrl = urlRow?.value?.replace(/\/+$/, "");
    const apiKey = keyRow?.value;
    if (!baseUrl || !apiKey) {
      return res.status(500).json({ error: "Unipile config not found in app_settings" });
    }

    const headers: Record<string, string> = {
      "X-API-KEY": apiKey,
      "X-ACCOUNT-ID": account_id,
      Accept: "application/json",
    };

    /** Fetch a paginated Unipile endpoint, accumulating all pages (up to safety limit). */
    async function fetchAllPages(url: string, maxItems = 1000): Promise<any[]> {
      const all: any[] = [];
      let nextCursor: string | null = cursor || null;
      let page = 0;

      do {
        const pageUrl = new URL(url);
        pageUrl.searchParams.set("account_id", account_id);
        pageUrl.searchParams.set("limit", "100");
        if (nextCursor) pageUrl.searchParams.set("cursor", nextCursor);

        const resp = await fetch(pageUrl.toString(), { headers });

        if (resp.status === 429) {
          return res.status(429).json({
            error: "Unipile rate limit reached. Please wait a moment and try again.",
          }) as any;
        }
        if (!resp.ok) {
          const errText = await resp.text();
          console.error(`Unipile error (page ${page}): ${resp.status}`, errText);
          throw new Error(`Unipile error ${resp.status}: ${errText}`);
        }

        const data = await resp.json();
        const items = data.items ?? data.results ?? (Array.isArray(data) ? data : []);
        all.push(...items);

        nextCursor = data.cursor ?? data.next_cursor ?? null;
        page++;
      } while (nextCursor && all.length < maxItems && page < 10);

      return all;
    }

    // Route by action
    if (action === "list_accounts") {
      // Diagnostic: list all Unipile accounts to find correct IDs
      const resp = await fetch(`${baseUrl}/accounts`, { headers });
      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: errText });
      }
      const data = await resp.json();
      return res.status(200).json(data);
    }

    if (action === "list_projects") {
      const items = await fetchAllPages(`${baseUrl}/linkedin/projects`);
      if (res.headersSent) return;
      return res.status(200).json({ items });
    }

    if (action === "list_applicants") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id (project_id)" });

      // Track what we tried so the UI can surface a meaningful error if the
      // applicants list comes back empty. Unipile's LinkedIn-Recruiter routes
      // have moved more than once — keep multiple endpoint shapes in play
      // and return the first one that yields rows.
      const metaParams = new URLSearchParams({ account_id });
      let projectData: any = null;
      let applicants: any[] = [];
      const tries: { url: string; status?: number; ok: boolean; count?: number; error?: string }[] = [];

      // 1) project detail — applicants may come embedded (varied field names)
      const projectUrl = `${baseUrl}/linkedin/projects/${encodeURIComponent(job_id)}?${metaParams}`;
      try {
        const metaResp = await fetch(projectUrl, { headers });
        const t: any = { url: projectUrl, status: metaResp.status, ok: metaResp.ok };
        if (metaResp.ok) {
          projectData = await metaResp.json();
          const embedded = projectData?.applicants ?? projectData?.candidates
            ?? projectData?.members ?? projectData?.profiles ?? projectData?.items
            ?? projectData?.results ?? projectData?.matched_candidates ?? [];
          applicants = Array.isArray(embedded) ? embedded : [];
          t.count = applicants.length;
          t.keys = projectData ? Object.keys(projectData).slice(0, 30) : [];
        } else {
          t.error = (await metaResp.text()).slice(0, 500);
        }
        tries.push(t);
      } catch (err: any) {
        tries.push({ url: projectUrl, ok: false, error: err.message });
      }

      // 2) Try every known applicants sub-endpoint in turn until one yields rows.
      // Unipile has used at least three URL shapes for LinkedIn Recruiter
      // candidates over time — try each and stop at the first match.
      const candidateEndpoints = [
        `${baseUrl}/linkedin/projects/${encodeURIComponent(job_id)}/applicants`,
        `${baseUrl}/linkedin/projects/${encodeURIComponent(job_id)}/candidates`,
        `${baseUrl}/linkedin/recruiter/projects/${encodeURIComponent(job_id)}/candidates`,
        `${baseUrl}/linkedin/hiring/projects/${encodeURIComponent(job_id)}/candidates`,
      ];

      for (const ep of candidateEndpoints) {
        if (applicants.length > 0) break;
        try {
          const appParams = new URLSearchParams({ account_id, limit: "100" });
          if (cursor) appParams.set("cursor", cursor);
          const appResp = await fetch(`${ep}?${appParams}`, { headers });
          const t: any = { url: ep, status: appResp.status, ok: appResp.ok };
          if (appResp.ok) {
            const appData = await appResp.json();
            applicants = appData?.items ?? appData?.results ?? appData?.candidates
              ?? appData?.applicants ?? (Array.isArray(appData) ? appData : []);
            t.count = applicants.length;
          } else {
            t.error = (await appResp.text()).slice(0, 500);
          }
          tries.push(t);
        } catch (err: any) {
          tries.push({ url: ep, ok: false, error: err.message });
        }
      }

      // Normalize stage values from Recruiter pipeline stages to display stages
      applicants = applicants.map((a: any) => {
        const rawStage = (a.stage || a.status || a.pipeline_stage || a.pipelineStage || "unknown")
          .toLowerCase().replace(/_/g, " ");
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

      // Return tries[] when empty so the UI can show why nothing came back.
      return res.status(200).json({
        items: applicants,
        project: projectData,
        debug: applicants.length === 0 ? { tries } : undefined,
      });
    }

    if (action === "download_resume") {
      if (!job_id || !applicant_id) {
        return res.status(400).json({ error: "Missing job_id or applicant_id" });
      }
      const params = new URLSearchParams({ account_id });

      const resp = await fetch(
        `${baseUrl}/linkedin/jobs/${encodeURIComponent(job_id)}/applicants/${encodeURIComponent(applicant_id)}/resume?${params}`,
        { headers },
      );

      if (resp.status === 429) {
        return res.status(429).json({
          error: "Unipile rate limit reached. Please wait a moment and try again.",
        });
      }
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`Unipile download_resume error: ${resp.status}`, errText);
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: errText });
      }

      // Unipile may return JSON with base64 or raw binary — handle both
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await resp.json();
        return res.status(200).json(data);
      }

      // Raw binary — convert to base64
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
