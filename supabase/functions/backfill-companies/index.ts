import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * backfill-companies
 *
 * Two modes:
 *   mode=local  (default) — parse linkedin_profile_data JSON already stored in DB
 *   mode=api    — call Unipile for profiles that don't have stored data
 *
 * Body: { table?: "candidates"|"contacts"|"both", limit?: number, mode?: "local"|"api", account_id?: string }
 */
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const body = await req.json().catch(() => ({}));
    const table = body.table ?? 'both';
    const limit = Math.min(body.limit ?? 100, 500);
    const mode = body.mode ?? 'local';

    const results: any = {};

    // ── CANDIDATES ──────────────────────────────────────────────────────
    if (table === 'candidates' || table === 'both') {
      if (mode === 'local') {
        results.candidates = await backfillFromLocal(supabase, 'candidates', limit);
      } else {
        const accountId = await resolveAccountId(supabase, body.account_id);
        if (!accountId) return jsonResp({ error: 'No Unipile account found' }, 422);
        results.candidates = await backfillFromApi(supabase, 'candidates', limit, accountId);
      }
    }

    // ── CONTACTS ────────────────────────────────────────────────────────
    if (table === 'contacts' || table === 'both') {
      if (mode === 'local') {
        results.contacts = await backfillFromLocal(supabase, 'contacts', limit);
      } else {
        const accountId = await resolveAccountId(supabase, body.account_id);
        if (!accountId) return jsonResp({ error: 'No Unipile account found' }, 422);
        results.contacts = await backfillFromApi(supabase, 'contacts', limit, accountId);
      }
    }

    return jsonResp({ success: true, mode, results });
  } catch (err: any) {
    console.error('backfill-companies error:', err);
    return jsonResp({ error: err.message }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MODE: local — parse company from linkedin_profile_data already in DB
// ═══════════════════════════════════════════════════════════════════════════

async function backfillFromLocal(supabase: any, table: string, limit: number) {
  const companyCol = table === 'candidates' ? 'current_company' : 'company_name';
  const titleCol = table === 'candidates' ? 'current_title' : 'title';

  // Find records with profile data but no company
  const { data: records, error } = await supabase
    .from(table)
    .select(`id, ${companyCol}, ${titleCol}, linkedin_profile_data`)
    .not('linkedin_profile_data', 'is', null)
    .or(`${companyCol}.is.null,${companyCol}.eq.`)
    .limit(limit);

  if (error) {
    console.error(`Failed to query ${table}:`, error);
    return { error: error.message };
  }

  let updated = 0;
  let skipped = 0;
  const samples: string[] = [];

  for (const rec of records ?? []) {
    try {
      const profileJson = typeof rec.linkedin_profile_data === 'string'
        ? JSON.parse(rec.linkedin_profile_data)
        : rec.linkedin_profile_data;

      const company = extractCompanyFromProfile(profileJson);
      const title = extractTitleFromProfile(profileJson);

      const updates: Record<string, string> = {};
      if (company && !rec[companyCol]) updates[companyCol] = company;
      if (title && !rec[titleCol]) updates[titleCol] = title;

      if (Object.keys(updates).length > 0) {
        await supabase.from(table).update(updates).eq('id', rec.id);
        updated++;
        if (samples.length < 5) {
          samples.push(`${rec.id}: ${JSON.stringify(updates)}`);
        }
      } else {
        skipped++;
      }
    } catch (err: any) {
      console.error(`Parse error ${rec.id}:`, err.message);
      skipped++;
    }
  }

  return { total: records?.length ?? 0, updated, skipped, samples };
}

function extractCompanyFromProfile(p: any): string | null {
  // 1. Check positions/experience array
  const positions: any[] =
    p.positions ?? p.experience ?? p.work_experience ?? p.jobs ?? [];
  if (positions.length > 0) {
    const current = positions.find((pos: any) =>
      pos.is_current === true || pos.current === true || !pos.end_date
    ) ?? positions[0];
    const company = current?.company?.name ?? current?.company_name ?? current?.organization ?? null;
    if (company) return company;
  }

  // 2. Parse "Title at Company" from headline
  const headline = p.headline ?? '';
  if (headline.includes(' at ')) {
    const parts = headline.split(' at ');
    const company = parts[parts.length - 1].trim();
    if (company && company.length > 1) return company;
  }

  // 3. Parse "Title | Company" or "Title - Company"
  for (const sep of [' | ', ' - ', ' — ']) {
    if (headline.includes(sep)) {
      const parts = headline.split(sep);
      if (parts.length >= 2) {
        const candidate = parts[parts.length - 1].trim();
        // Heuristic: company names usually start with uppercase
        if (candidate && candidate[0] === candidate[0].toUpperCase() && candidate.length > 1) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function extractTitleFromProfile(p: any): string | null {
  const positions: any[] =
    p.positions ?? p.experience ?? p.work_experience ?? p.jobs ?? [];
  if (positions.length > 0) {
    const current = positions.find((pos: any) =>
      pos.is_current === true || pos.current === true || !pos.end_date
    ) ?? positions[0];
    return current?.title ?? current?.role ?? null;
  }

  // Parse from headline: "Title at Company"
  const headline = p.headline ?? '';
  if (headline.includes(' at ')) {
    return headline.split(' at ')[0].trim() || null;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// MODE: api — call Unipile for profiles not yet in DB
// ═══════════════════════════════════════════════════════════════════════════

async function backfillFromApi(supabase: any, table: string, limit: number, accountId: string) {
  const companyCol = table === 'candidates' ? 'current_company' : 'company_name';
  const titleCol = table === 'candidates' ? 'current_title' : 'title';

  const unipileApiKey = Deno.env.get('UNIPILE_API_KEY')!;
  const unipileBaseUrl = Deno.env.get('UNIPILE_BASE_URL')!;

  // Records with linkedin_url but no company AND no stored profile data
  const { data: records, error } = await supabase
    .from(table)
    .select(`id, linkedin_url, ${companyCol}, ${titleCol}`)
    .not('linkedin_url', 'is', null)
    .is('linkedin_profile_data', null)
    .or(`${companyCol}.is.null,${companyCol}.eq.`)
    .limit(limit);

  if (error) return { error: error.message };

  let updated = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const rec of records ?? []) {
    const providerId = extractLinkedInId(rec.linkedin_url);
    if (!providerId) { failed++; continue; }

    try {
      const base = unipileBaseUrl.replace(/\/api\/v1\/?$/, '');
      const url = `${base}/api/v1/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(accountId)}`;
      const res = await fetch(url, { headers: { 'X-API-KEY': unipileApiKey } });

      if (!res.ok) {
        errors.push(`${providerId}: HTTP ${res.status}`);
        failed++;
        await delay(500);
        continue;
      }

      const profile = await res.json();

      // Store raw profile data for future use
      await supabase.from(table)
        .update({ linkedin_profile_data: JSON.stringify(profile) })
        .eq('id', rec.id);

      const company = extractCompanyFromProfile(profile);
      const title = extractTitleFromProfile(profile);

      const updates: Record<string, string> = {};
      if (company) updates[companyCol] = company;
      if (title && !rec[titleCol]) updates[titleCol] = title;

      if (Object.keys(updates).length > 0) {
        await supabase.from(table).update(updates).eq('id', rec.id);
        updated++;
      } else {
        failed++;
      }

      await delay(500);
    } catch (err: any) {
      errors.push(`${providerId}: ${err.message}`);
      failed++;
    }
  }

  return { total: records?.length ?? 0, updated, failed, errors: errors.slice(0, 10) };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function jsonResp(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractLinkedInId(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function resolveAccountId(supabase: any, override?: string): Promise<string | null> {
  if (override) return override;
  const { data } = await supabase
    .from('integration_accounts')
    .select('unipile_account_id')
    .not('unipile_account_id', 'is', null)
    .eq('is_active', true)
    .limit(1);
  return data?.[0]?.unipile_account_id ?? null;
}
