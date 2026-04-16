import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * GET /api/jobs/[id]/matches?page=1
 * Returns paginated AI candidate matches for a job.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const jobId = req.query.id as string;
  if (!jobId) {
    return res.status(400).json({ error: "Missing job id" });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const page = parseInt((req.query.page as string) || "1");
  const limit = Math.min(parseInt((req.query.per_page as string) || "25"), 100);
  const offset = (page - 1) * limit;

  // Get total count (only matches with overall_score > 0)
  const { count } = await supabase
    .from("job_candidate_matches")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId)
    .gt("overall_score", 0);

  // Get paginated matches with candidate info (score > 0 only)
  const { data, error } = await supabase
    .from("job_candidate_matches")
    .select(
      `
      id,
      overall_score,
      tier,
      reasoning,
      strengths,
      concerns,
      vector_similarity,
      created_at,
      candidate_id,
      candidates!inner (
        id,
        full_name,
        current_title,
        current_company,
        location,
        location_text,
        linkedin_url,
        avatar_url,
        profile_picture_url,
        status
      )
    `
    )
    .eq("job_id", jobId)
    .gt("overall_score", 0)
    .order("overall_score", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    matches: data || [],
    total: count || 0,
    page,
    totalPages: Math.ceil((count || 0) / limit),
  });
}
