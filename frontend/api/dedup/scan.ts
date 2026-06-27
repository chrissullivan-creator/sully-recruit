import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { diceSimilarity, normalizeText, normalizeCompany } from "../lib/fuzzy-match-person.js";

/**
 * POST /api/dedup/scan
 *
 * Scans the candidates table for likely duplicates and upserts pending pairs
 * into duplicate_candidates. Two passes:
 *
 *   1. EXACT — re-use the pre-computed match keys (email/phone/linkedin), which
 *      triggers keep current. Any key shared by ≥2 rows is a near-certain dup
 *      (confidence 1.0).
 *   2. FUZZY (match_type 'name') — catch the dups the keys miss: the same
 *      person under a name variant (Greg/Gregory, middle name) at the same firm.
 *      Blocks candidates by normalized last name (cheap, keeps it O(block²) not
 *      O(n²)), then scores name + firm + title with Dice similarity. Confidence
 *      is the blended score (capped < 1.0 so exact matches always rank above).
 *
 * Synchronous: completes inline so the UI can refetch right after. Re-scans are
 * idempotent — UNIQUE(candidate_id_a, candidate_id_b) + ignoreDuplicates, and
 * the exact pass runs first so a pair found both ways keeps its exact type.
 *
 * Auth: Supabase JWT (logged-in user) or service role key. Body: none.
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
    first_name: string | null;
    last_name: string | null;
    full_name: string | null;
    current_title: string | null;
    current_company: string | null;
  };

  // Pull candidates that have at least one match key OR a last name (the fuzzy
  // pass needs name/firm/title even for rows with no email/phone/linkedin).
  const PAGE = 1000;
  const all: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("candidates")
      .select(
        "id, email_match_key, phone_match_key, linkedin_match_key, first_name, last_name, full_name, current_title, current_company",
      )
      .or(
        "email_match_key.not.is.null,phone_match_key.not.is.null,linkedin_match_key.not.is.null,last_name.not.is.null",
      )
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("scan: candidate fetch error", error.message);
      return res.status(500).json({ error: error.message });
    }
    if (!data || data.length === 0) break;
    all.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  type Pair = {
    candidate_id_a: string;
    candidate_id_b: string;
    match_type: string;
    match_value: string;
    confidence: number;
  };
  const pairs: Pair[] = [];
  const seen = new Set<string>();

  // Stable pair key + dedupe guard. Returns false if the pair was already
  // recorded (by an earlier, stronger pass), so callers can skip it.
  const claimPair = (a: string, b: string): { a: string; b: string } | null => {
    const [x, y] = a < b ? [a, b] : [b, a];
    const key = `${x}|${y}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return { a: x, b: y };
  };

  // ── Pass 1: exact match keys ──
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
          const claimed = claimPair(sorted[i], sorted[j]);
          if (!claimed) continue;
          pairs.push({
            candidate_id_a: claimed.a,
            candidate_id_b: claimed.b,
            match_type: type,
            match_value: k,
            confidence: 1.0,
          });
        }
      }
    }
  };

  collect("email_match_key", "email");
  collect("phone_match_key", "phone");
  collect("linkedin_match_key", "linkedin");

  // ── Pass 2: fuzzy name + firm + title (blocked by last name) ──
  // Tunables: a strong-enough name plus corroboration from firm/title, OR a
  // near-identical full name on its own. Confidence is capped below 1.0 so
  // exact matches always sort above fuzzy ones in the review list.
  const NAME_MIN = 0.84; // gate on name similarity
  const NAME_ALONE = 0.93; // near-identical full name qualifies without firm/title
  const CORROBORATE = 0.55; // firm or title similarity needed below NAME_ALONE
  const SCORE_FLOOR = 0.8; // don't surface anything weaker than 80%
  const SCORE_CAP = 0.97; // keep fuzzy under exact (1.0)
  const MAX_BLOCK = 1500; // skip pathologically generic surnames

  const fullName = (r: Row) =>
    (r.full_name || `${r.first_name ?? ""} ${r.last_name ?? ""}`).trim();

  const blocks = new Map<string, Row[]>();
  for (const r of all) {
    const ln = normalizeText(r.last_name);
    if (!ln || !fullName(r)) continue;
    const arr = blocks.get(ln) ?? [];
    arr.push(r);
    blocks.set(ln, arr);
  }

  let fuzzyFound = 0;
  let skippedBlocks = 0;
  for (const [, members] of blocks) {
    if (members.length < 2) continue;
    if (members.length > MAX_BLOCK) {
      skippedBlocks += 1;
      continue;
    }
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        const nameSim = diceSimilarity(fullName(a), fullName(b));
        if (nameSim < NAME_MIN) continue;

        const companySim =
          a.current_company && b.current_company
            ? diceSimilarity(normalizeCompany(a.current_company), normalizeCompany(b.current_company))
            : 0;
        const titleSim =
          a.current_title && b.current_title
            ? diceSimilarity(a.current_title, b.current_title)
            : 0;

        const corroborated = companySim >= CORROBORATE || titleSim >= CORROBORATE;
        if (nameSim < NAME_ALONE && !corroborated) continue;

        // Blended score, renormalized over the signals we actually have.
        let wSum = 0.6;
        let acc = 0.6 * nameSim;
        if (a.current_company && b.current_company) { wSum += 0.25; acc += 0.25 * companySim; }
        if (a.current_title && b.current_title) { wSum += 0.15; acc += 0.15 * titleSim; }
        const score = Math.min(SCORE_CAP, acc / wSum);
        if (score < SCORE_FLOOR) continue;

        const claimed = claimPair(a.id, b.id);
        if (!claimed) continue; // already matched exactly — keep the stronger type
        pairs.push({
          candidate_id_a: claimed.a,
          candidate_id_b: claimed.b,
          match_type: "name",
          match_value: `${fullName(a)} ≈ ${fullName(b)}`.slice(0, 200),
          confidence: Number(score.toFixed(3)),
        });
        fuzzyFound += 1;
      }
    }
  }

  if (pairs.length === 0) {
    return res.status(200).json({ scanned: all.length, found: 0, inserted: 0, fuzzy: 0 });
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

  return res.status(200).json({
    scanned: all.length,
    found: pairs.length,
    inserted,
    fuzzy: fuzzyFound,
    skipped_generic_blocks: skippedBlocks,
  });
}
