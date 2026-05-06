import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { parseResume } from "../src/lib/resume-parser";

/**
 * POST /api/parse-resume
 *
 * Downloads a resume from Supabase Storage and runs the shared parser
 * (Eden AI → Affinda). Returns parsed JSON. No DB writes — the calling
 * dialog persists candidate fields.
 *
 * EDEN_AI_API_KEY: env var preferred; falls back to app_settings row.
 * Body: { filePath: string, fileName: string }
 * Auth: Supabase JWT (from logged-in user)
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) {
    return res.status(500).json({ error: "Server misconfigured: missing Supabase credentials" });
  }

  // Auth: validate Supabase JWT
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  const supabase = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY || serviceKey);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { filePath, fileName } = req.body;
    if (!filePath || !fileName) {
      return res.status(400).json({ error: "Missing required fields: filePath, fileName" });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Resolve Eden key: env first, then app_settings.
    let edenKey = process.env.EDEN_AI_API_KEY || "";
    if (!edenKey) {
      const { data } = await admin.from("app_settings").select("value").eq("key", "EDEN_AI_API_KEY").maybeSingle();
      edenKey = data?.value || "";
    }
    if (!edenKey) {
      return res.status(500).json({ error: "EDEN_AI_API_KEY not configured" });
    }

    const { data: downloadData, error: downloadErr } = await admin.storage
      .from("resumes")
      .download(filePath);
    if (downloadErr || !downloadData) {
      return res.status(500).json({
        error: `Failed to download file: ${downloadErr?.message || "no data"}`,
      });
    }

    const fileBytes = new Uint8Array(await downloadData.arrayBuffer());
    const result = await parseResume(fileBytes, fileName, {
      edenKey,
      log: { warn: (m, meta) => console.warn(m, meta) },
    });

    return res.status(200).json({ parsed: result.parsed, via: result.via });
  } catch (err: any) {
    console.error("Parse resume error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
