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

      // Fetch project detail — members are embedded in this response
      const params = new URLSearchParams({ account_id });
      const resp = await fetch(
        `${baseUrl}/linkedin/projects/${encodeURIComponent(job_id)}?${params}`,
        { headers },
      );

      if (resp.status === 429) {
        return res.status(429).json({
          error: "Unipile rate limit reached. Please wait a moment and try again.",
        });
      }
      if (!resp.ok) {
        const errText = await resp.text();
        console.error(`Unipile project detail error: ${resp.status}`, errText);
        return res.status(resp.status).json({ error: `Unipile error: ${resp.status}`, detail: errText });
      }

      const data = await resp.json();

      // Log full response shape for debugging
      console.log("Unipile project detail keys:", Object.keys(data));
      for (const key of Object.keys(data)) {
        const val = data[key];
        if (Array.isArray(val)) {
          console.log(`  ${key}: Array[${val.length}]`, val.length > 0 ? Object.keys(val[0]) : "empty");
        } else if (val && typeof val === "object") {
          console.log(`  ${key}: Object`, Object.keys(val));
        } else {
          console.log(`  ${key}:`, typeof val, String(val).slice(0, 100));
        }
      }

      // Extract applicants — try known field names, then scan for any array of objects
      let applicants: any[] =
        data.applicants ?? data.candidates ?? data.items ?? data.members
        ?? data.profiles ?? data.results ?? data.people ?? data.contacts ?? null;

      if (!Array.isArray(applicants)) {
        // Deep scan: find the first sizeable array of objects in the response
        for (const key of Object.keys(data)) {
          const val = data[key];
          if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
            console.log(`Found applicant array under key: "${key}" (${val.length} items)`);
            applicants = val;
            break;
          }
        }
        // Also check one level deep (e.g. data.pipeline.candidates)
        if (!Array.isArray(applicants)) {
          for (const key of Object.keys(data)) {
            const val = data[key];
            if (val && typeof val === "object" && !Array.isArray(val)) {
              for (const subKey of Object.keys(val)) {
                const subVal = val[subKey];
                if (Array.isArray(subVal) && subVal.length > 0 && typeof subVal[0] === "object") {
                  console.log(`Found applicant array under key: "${key}.${subKey}" (${subVal.length} items)`);
                  applicants = subVal;
                  break;
                }
              }
              if (Array.isArray(applicants)) break;
            }
          }
        }
      }

      if (!Array.isArray(applicants)) applicants = [];

      return res.status(200).json({ items: applicants, project: data });
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
