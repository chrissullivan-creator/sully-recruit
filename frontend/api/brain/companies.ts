import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { requireAuth } from "../lib/auth.js";

/**
 * POST /api/brain/companies
 *
 * Find companies by name / domain. Returns id, name, domain, plus a count
 * of open jobs and known contacts at that company.
 *
 * Body: { query: string, limit?: number (default 10, max 25) }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!(await requireAuth(req, res))) return;

  const query = String(req.body?.query ?? "").trim();
  if (!query) return res.status(400).json({ error: "query required" });
  const limit = Math.min(Math.max(Number(req.body?.limit) || 10, 1), 25);

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: companies, error } = await supabase
    .from("companies")
    .select("id, name, domain, location, linkedin_url")
    .or(`name.ilike.%${query}%,domain.ilike.%${query}%`)
    .limit(limit);
  if (error) return res.status(500).json({ error: error.message });

  if (!companies || companies.length === 0) {
    return res.status(200).json({ query, count: 0, companies: [] });
  }

  const ids = companies.map((c: any) => c.id);
  const [jobsRes, contactsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("company_id, status")
      .in("company_id", ids)
      .is("deleted_at", null),
    supabase
      .from("candidates")
      .select("company_id")
      .in("company_id", ids)
      .contains("roles", ["client"]),
  ]);

  const jobsByCompany: Record<string, { total: number; active: number }> = {};
  for (const j of (jobsRes.data as any[]) ?? []) {
    if (!j.company_id) continue;
    const entry = jobsByCompany[j.company_id] ?? { total: 0, active: 0 };
    entry.total++;
    if (j.status === "active" || j.status === "open") entry.active++;
    jobsByCompany[j.company_id] = entry;
  }

  const contactsByCompany: Record<string, number> = {};
  for (const c of (contactsRes.data as any[]) ?? []) {
    if (!c.company_id) continue;
    contactsByCompany[c.company_id] = (contactsByCompany[c.company_id] ?? 0) + 1;
  }

  return res.status(200).json({
    query,
    count: companies.length,
    companies: companies.map((c: any) => ({
      ...c,
      jobs_total: jobsByCompany[c.id]?.total ?? 0,
      jobs_active: jobsByCompany[c.id]?.active ?? 0,
      contacts_count: contactsByCompany[c.id] ?? 0,
    })),
  });
}
