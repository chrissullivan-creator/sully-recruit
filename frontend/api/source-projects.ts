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
      Accept: "application/json",
    };

    // Route by action
    if (action === "list_projects") {
      const params = new URLSearchParams({ account_id, limit: "100" });
      if (cursor) params.set("cursor", cursor);

      const resp = await fetch(`${baseUrl}/linkedin/hiring_projects?${params}`, { headers });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`Unipile list_projects error: ${resp.status}`, errText);
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: errText });
      }
      const data = await resp.json();
      return res.status(200).json(data);
    }

    if (action === "list_applicants") {
      if (!job_id) return res.status(400).json({ error: "Missing job_id" });
      const params = new URLSearchParams({ account_id, limit: "100" });
      if (cursor) params.set("cursor", cursor);

      const resp = await fetch(`${baseUrl}/jobs/${encodeURIComponent(job_id)}/applicants?${params}`, { headers });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`Unipile list_applicants error: ${resp.status}`, errText);
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: errText });
      }
      const data = await resp.json();
      return res.status(200).json(data);
    }

    if (action === "download_resume") {
      if (!job_id || !applicant_id) {
        return res.status(400).json({ error: "Missing job_id or applicant_id" });
      }
      const params = new URLSearchParams({ account_id });

      const resp = await fetch(
        `${baseUrl}/jobs/${encodeURIComponent(job_id)}/applicants/${encodeURIComponent(applicant_id)}/resume?${params}`,
        { headers },
      );
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
