import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const UNIPILE_API_KEY = Deno.env.get("UNIPILE_API_KEY") || "";
const UNIPILE_API_URL = Deno.env.get("UNIPILE_API_URL") || "https://api2.unipile.com:13080";

// Nancy's recruiter Unipile account ID
const NANCY_UNIPILE_ACCOUNT_ID = "ZsitoJXDQ8iSD6xGfpwj1A";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function extractSlug(linkedinUrl: string): string | null {
  const m = linkedinUrl.replace(/\/+$/, "").match(/linkedin\.com\/in\/([^/?\s#]+)/);
  const slug = m?.[1];
  if (!slug) return null;
  // Skip if already a Unipile ID
  if (slug.startsWith("ACo") || slug.startsWith("ACw") || slug.startsWith("acw")) return null;
  return slug;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    // Fetch candidates from last 7 days with LinkedIn URL but no unipile_id
    const { data: candidates, error } = await supabase
      .from("candidates")
      .select("id, full_name, linkedin_url, unipile_id")
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .is("unipile_id", null)
      .not("linkedin_url", "is", null)
      .neq("linkedin_url", "");

    if (error) throw error;

    const results: Record<string, unknown>[] = [];
    let resolved = 0, failed = 0, skipped = 0;

    for (const candidate of candidates ?? []) {
      const slug = extractSlug(candidate.linkedin_url);
      if (!slug) {
        skipped++;
        results.push({ id: candidate.id, name: candidate.full_name, status: "skipped", reason: "no_slug" });
        continue;
      }

      try {
        // Use Nancy's recruiter account for lookup
        const url = `${UNIPILE_API_URL}/api/v1/users/${encodeURIComponent(slug)}?account_id=${NANCY_UNIPILE_ACCOUNT_ID}`;
        const resp = await fetch(url, {
          headers: {
            "X-API-KEY": UNIPILE_API_KEY,
            "Accept": "application/json",
          },
        });

        if (!resp.ok) {
          const errText = await resp.text();
          failed++;
          results.push({ id: candidate.id, name: candidate.full_name, status: "failed", error: `${resp.status}: ${errText}` });
          await sleep(500);
          continue;
        }

        const profile = await resp.json();

        // Skip self
        if (profile.is_self === true) {
          skipped++;
          results.push({ id: candidate.id, name: candidate.full_name, status: "skipped", reason: "is_self" });
          continue;
        }

        const unipileId = (profile.provider_id ?? profile.id ?? null) as string | null;
        if (!unipileId) {
          failed++;
          results.push({ id: candidate.id, name: candidate.full_name, status: "failed", reason: "no_id_in_response" });
          continue;
        }

        // Update candidate
        const { error: updateErr } = await supabase
          .from("candidates")
          .update({ unipile_id: unipileId, updated_at: new Date().toISOString() })
          .eq("id", candidate.id);

        if (updateErr) throw updateErr;

        resolved++;
        results.push({ id: candidate.id, name: candidate.full_name, status: "resolved", unipile_id: unipileId });

        // Polite delay to avoid Unipile rate limiting
        await sleep(400);
      } catch (err: any) {
        failed++;
        results.push({ id: candidate.id, name: candidate.full_name, status: "error", error: err.message });
      }
    }

    console.log(`[resolve-recent-candidates] resolved=${resolved} failed=${failed} skipped=${skipped}`);
    return json({ ok: true, total: candidates?.length ?? 0, resolved, failed, skipped, results });
  } catch (err: any) {
    console.error("[fatal]", err);
    return json({ ok: false, error: err.message }, 500);
  }
});
