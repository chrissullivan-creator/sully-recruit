import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") ?? "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") ?? "https://api2.unipile.com:13080";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { ...cors, "Content-Type": "application/json" } });
const uniH = () => ({ "X-API-KEY": UNIPILE_API_KEY, "Accept": "application/json", "Content-Type": "application/json" });

function extractSlug(url: string): string | null {
  const m = url.replace(/\/+$/, "").match(/linkedin\.com\/in\/([^/?\s#]+)/);
  return m?.[1] ?? null;
}

// Column mapping: sales_nav → unipile_sales_nav_id | recruiter → unipile_recruiter_id | classic → unipile_classic_id
async function resolveViaSalesNavSearch(accountId: string, fullName: string, slug: string | null): Promise<{ acw: string | null; confidence: string }> {
  const r = await fetch(`${UNIPILE_API_URL}/api/v1/linkedin/search?account_id=${accountId}`, {
    method: "POST", headers: uniH(),
    body: JSON.stringify({ api: "sales_navigator", keywords: fullName, category: "people", limit: 10 }),
  });
  if (!r.ok) return { acw: null, confidence: `search_failed_${r.status}` };
  const data: Record<string, unknown> = await r.json().catch(() => ({}));
  const items: Record<string, unknown>[] = (data.items as Record<string, unknown>[]) ?? [];
  if (slug) {
    const ex = items.find(i => i.public_identifier === slug || String(i.profile_url ?? "").includes(slug) || String(i.public_profile_url ?? "").includes(slug));
    if (ex?.id && String(ex.id).startsWith("ACw")) return { acw: String(ex.id), confidence: "slug_match" };
  }
  if (items.length === 1 && String(items[0].id ?? "").startsWith("ACw")) return { acw: String(items[0].id), confidence: "single_result" };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nm = items.find(i => norm(String(i.name ?? "")) === norm(fullName));
  if (nm?.id && String(nm.id).startsWith("ACw")) return { acw: String(nm.id), confidence: "name_match" };
  return { acw: null, confidence: `no_match_in_${items.length}` };
}

async function resolveViaProfile(slug: string, accountId: string): Promise<string | null> {
  const r = await fetch(`${UNIPILE_API_URL}/api/v1/users/${encodeURIComponent(slug)}?account_id=${accountId}`, { headers: uniH() });
  if (!r.ok) return null;
  const p: Record<string, unknown> = await r.json().catch(() => ({}));
  if (p.is_self === true) return null;
  return (p.provider_id ?? p.id ?? null) as string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const body = await req.json().catch(() => ({}));
  const { sequence_id, dry_run } = body;
  if (!sequence_id) return respond({ error: "sequence_id required" }, 400);
  if (!UNIPILE_API_KEY) return respond({ error: "UNIPILE_API_KEY not set" }, 500);

  const { data: accounts } = await supabase
    .from("integration_accounts")
    .select("id,unipile_account_id,linkedin_capability")
    .eq("provider", "linkedin").eq("is_active", true)
    .not("unipile_account_id", "is", null);

  const capMap: Record<string, { id: string; unipile_account_id: string }> = {};
  for (const a of accounts ?? []) { if (a.linkedin_capability) capMap[a.linkedin_capability] = a; }
  console.log("[resolve-sequence] caps:", Object.keys(capMap).join(", "));

  const { data: enrollments } = await supabase
    .from("sequence_enrollments")
    .select("candidate_id")
    .eq("sequence_id", sequence_id)
    .in("status", ["active", "paused"])
    .not("candidate_id", "is", null);

  const ids = [...new Set((enrollments ?? []).map((e: Record<string, unknown>) => e.candidate_id as string))];
  if (!ids.length) return respond({ error: "no candidates found" }, 400);

  const { data: candidates } = await supabase
    .from("candidates")
    .select("id,full_name,linkedin_url,unipile_sales_nav_id,unipile_recruiter_id,unipile_classic_id")
    .in("id", ids)
    .not("linkedin_url", "is", null);

  let resolved = 0, failed = 0, skipped = 0, complete = 0;
  const results: Record<string, unknown>[] = [];

  for (const c of candidates ?? []) {
    if (c.unipile_sales_nav_id && c.unipile_recruiter_id && c.unipile_classic_id) { complete++; continue; }
    const slug = extractSlug(c.linkedin_url ?? "");
    if (!slug || slug.startsWith("ACo") || slug.startsWith("ACw")) { skipped++; continue; }

    const updates: Record<string, string> = {};
    const r: Record<string, unknown> = { name: c.full_name, slug };

    // Sales Nav (ACw) — search for best accuracy
    if (!c.unipile_sales_nav_id && capMap["sales_nav"]) {
      const { acw, confidence } = await resolveViaSalesNavSearch(capMap["sales_nav"].unipile_account_id, c.full_name, slug);
      r.sales_nav = { id: acw, confidence };
      if (acw) updates.unipile_sales_nav_id = acw;
      await new Promise(x => setTimeout(x, 1200));
    }
    // Recruiter (ACw) — profile lookup
    if (!c.unipile_recruiter_id && capMap["recruiter"]) {
      const uid = await resolveViaProfile(slug, capMap["recruiter"].unipile_account_id);
      r.recruiter = { id: uid };
      if (uid) updates.unipile_recruiter_id = uid;
      await new Promise(x => setTimeout(x, 500));
    }
    // Classic (ACo) — profile lookup
    if (!c.unipile_classic_id && capMap["classic"]) {
      const uid = await resolveViaProfile(slug, capMap["classic"].unipile_account_id);
      r.classic = { id: uid };
      if (uid) updates.unipile_classic_id = uid;
      await new Promise(x => setTimeout(x, 500));
    }

    if (Object.keys(updates).length > 0) {
      if (!dry_run) await supabase.from("candidates").update({ ...updates, updated_at: new Date().toISOString() }).eq("id", c.id);
      resolved++; r.status = dry_run ? "would_resolve" : "resolved";
    } else { failed++; r.status = "failed"; }
    results.push(r);
  }

  return respond({ ok: true, dry_run: dry_run === true, already_complete: complete, resolved, failed, skipped, total: (candidates ?? []).length, results });
});
