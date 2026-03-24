import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * backfill-companies
 *
 * Finds candidates and contacts with a linkedin_url but missing company info,
 * calls Unipile to fetch their current profile, and backfills
 * current_company (candidates) or company_name (contacts).
 *
 * Body: { table?: "candidates"|"contacts"|"both", limit?: number, account_id?: string }
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

    const unipileApiKey = Deno.env.get('UNIPILE_API_KEY');
    const unipileBaseUrl = Deno.env.get('UNIPILE_BASE_URL');

    if (!unipileApiKey || !unipileBaseUrl) {
      return jsonResp({ error: 'Unipile API not configured in env' }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const table = body.table ?? 'both';
    const limit = Math.min(body.limit ?? 50, 200);
    let accountId = body.account_id;

    // Resolve Unipile account ID if not provided
    if (!accountId) {
      const { data: accounts } = await supabase
        .from('integration_accounts')
        .select('unipile_account_id')
        .eq('provider', 'linkedin')
        .eq('is_active', true)
        .limit(1);
      accountId = accounts?.[0]?.unipile_account_id;
    }

    if (!accountId) {
      return jsonResp({ error: 'No active LinkedIn/Unipile account found' }, 422);
    }

    const results: any = { candidates: null, contacts: null };

    // ── Candidates ──────────────────────────────────────────────────────
    if (table === 'candidates' || table === 'both') {
      const { data: candidates, error } = await supabase
        .from('candidates')
        .select('id, linkedin_url, current_company, current_title')
        .not('linkedin_url', 'is', null)
        .or('current_company.is.null,current_company.eq.')
        .limit(limit);

      if (error) {
        console.error('Failed to fetch candidates:', error);
      } else {
        console.log(`Found ${candidates?.length ?? 0} candidates missing company`);
        let updated = 0;
        let failed = 0;

        for (const c of candidates ?? []) {
          const providerId = extractLinkedInId(c.linkedin_url);
          if (!providerId) { failed++; continue; }

          try {
            const profile = await fetchUnipileProfile(
              unipileBaseUrl, unipileApiKey, providerId, accountId
            );

            if (!profile) { failed++; continue; }

            const company = extractCurrentCompany(profile);
            const title = extractCurrentTitle(profile);

            const updates: Record<string, string> = {};
            if (company && !c.current_company) updates.current_company = company;
            if (title && !c.current_title) updates.current_title = title;

            if (Object.keys(updates).length > 0) {
              await supabase.from('candidates').update(updates).eq('id', c.id);
              updated++;
            }

            // Rate limit: ~2 req/sec
            await delay(500);
          } catch (err) {
            console.error(`Candidate ${c.id}:`, err);
            failed++;
          }
        }

        results.candidates = { total: candidates?.length ?? 0, updated, failed };
      }
    }

    // ── Contacts ────────────────────────────────────────────────────────
    if (table === 'contacts' || table === 'both') {
      const { data: contacts, error } = await supabase
        .from('contacts')
        .select('id, linkedin_url, company_name, title')
        .not('linkedin_url', 'is', null)
        .or('company_name.is.null,company_name.eq.')
        .limit(limit);

      if (error) {
        console.error('Failed to fetch contacts:', error);
      } else {
        console.log(`Found ${contacts?.length ?? 0} contacts missing company`);
        let updated = 0;
        let failed = 0;

        for (const c of contacts ?? []) {
          const providerId = extractLinkedInId(c.linkedin_url);
          if (!providerId) { failed++; continue; }

          try {
            const profile = await fetchUnipileProfile(
              unipileBaseUrl, unipileApiKey, providerId, accountId
            );

            if (!profile) { failed++; continue; }

            const company = extractCurrentCompany(profile);
            const title = extractCurrentTitle(profile);

            const updates: Record<string, string> = {};
            if (company && !c.company_name) updates.company_name = company;
            if (title && !c.title) updates.title = title;

            if (Object.keys(updates).length > 0) {
              await supabase.from('contacts').update(updates).eq('id', c.id);
              updated++;
            }

            await delay(500);
          } catch (err) {
            console.error(`Contact ${c.id}:`, err);
            failed++;
          }
        }

        results.contacts = { total: contacts?.length ?? 0, updated, failed };
      }
    }

    return jsonResp({ success: true, results });
  } catch (err: any) {
    console.error('backfill-companies error:', err);
    return jsonResp({ error: err.message }, 500);
  }
});

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
  // Handle various LinkedIn URL formats
  const match = url.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function fetchUnipileProfile(
  baseUrl: string, apiKey: string, providerId: string, accountId: string
): Promise<any | null> {
  const url = `${baseUrl}/api/v1/users/${encodeURIComponent(providerId)}?account_id=${encodeURIComponent(accountId)}`;
  const res = await fetch(url, {
    headers: { 'X-API-KEY': apiKey },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Unipile ${res.status} for ${providerId}:`, body);
    return null;
  }

  return res.json();
}

function extractCurrentCompany(profile: any): string | null {
  // Try current position first
  const positions: any[] =
    profile.positions ?? profile.experience ?? profile.work_experience ?? profile.jobs ?? [];

  const current = positions.find(
    (p: any) => p.is_current === true || p.current === true || !p.end_date
  );

  if (current) {
    return current.company?.name ?? current.company_name ?? current.organization ?? current.employer ?? null;
  }

  // Fallback: first position
  if (positions.length > 0) {
    const first = positions[0];
    return first.company?.name ?? first.company_name ?? first.organization ?? null;
  }

  // Fallback: headline parsing ("Title at Company")
  if (profile.headline && profile.headline.includes(' at ')) {
    return profile.headline.split(' at ').pop()?.trim() ?? null;
  }

  return null;
}

function extractCurrentTitle(profile: any): string | null {
  const positions: any[] =
    profile.positions ?? profile.experience ?? profile.work_experience ?? profile.jobs ?? [];

  const current = positions.find(
    (p: any) => p.is_current === true || p.current === true || !p.end_date
  );

  if (current) {
    return current.title ?? current.role ?? null;
  }

  if (positions.length > 0) {
    return positions[0].title ?? positions[0].role ?? null;
  }

  return null;
}
