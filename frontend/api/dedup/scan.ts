import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/dedup/scan
 *
 * Scans the candidates table for likely duplicates by re-using the
 * pre-computed match keys (email_match_key, phone_match_key,
 * linkedin_match_key) and upserts pending pairs into duplicate_candidates.
 *
 * Synchronous: completes inline so the UI can refetch right after.
 * The match keys are already maintained by triggers on people, so we
 * only need to find rows that share a non-null key.
 *
 * Auth: Supabase JWT (logged-in user) or service role key.
 * Body: none.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  if (!serviceKey || !supabaseUrl) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  if (token !== serviceKey) {
    const verifierKey =
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_ANON_KEY ||
      serviceKey;
    const supabaseAuth = createClient(supabaseUrl, verifierKey);
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  type Row = {
    id: string;
    email_match_key: string | null;
    phone_match_key: string | null;
    linkedin_match_key: string | null;
  };

  // Pull candidates that have at least one match key. Paginated.
  const PAGE = 1000;
  const all: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("candidates")
      .select("id, email_match_key, phone_match_key, linkedin_match_key")
      .or("email_match_key.not.is.null,phone_match_key.not.is.null,linkedin_match_key.not.is.null")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("scan: candidate fetch error", error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  type Pair = { candidate_id_a: string; candidate_id_b: string; match_type: string; match_value: string };
  const pairs: Pair[] = [];
  const seen = new Set<string>();

  const collect = (key: keyof Row, type: "email" | "phone" | "linkedin") => {
    const groups = new Map<string, string[]>();
    for (const r of all) {
      const k = r[key] as string | null;
      if (!k) continue;
      const arr = groups.get(k) ?? [];
      arr.push(r.id);
      groups.set(k, arr);
    }
    for (const [k, ids] of groups) {
      if (ids.length < 2) continue;
      const sorted = [...new Set(ids)].sort();
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          const dedupKey = `${a}|${b}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          pairs.push({ candidate_id_a: a, candidate_id_b: b, match_type: type, match_value: k });
        }
      }
    }
  };

  collect("email_match_key", "email");
  collect("phone_match_key", "phone");
  collect("linkedin_match_key", "linkedin");

  if (pairs.length === 0) {
    return res.status(200).json({ scanned: all.length, found: 0, inserted: 0 });
  }

  // Upsert; UNIQUE(candidate_id_a, candidate_id_b) means re-scans are idempotent.
  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const slice = pairs.slice(i, i + CHUNK);
    const { error, count } = await supabase
      .from("duplicate_candidates")
      .upsert(slice, { onConflict: "candidate_id_a,candidate_id_b", ignoreDuplicates: true, count: "exact" });
    if (error) {
      console.error("scan: upsert error", error.message);
      return res.status(500).json({ error: error.message, scanned: all.length, found: pairs.length, inserted });
    }
    inserted += count ?? 0;
  }

  return res.status(200).json({ scanned: all.length, found: pairs.length, inserted });
}
