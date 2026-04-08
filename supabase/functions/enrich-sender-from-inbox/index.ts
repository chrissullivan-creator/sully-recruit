import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * enrich-sender-from-inbox
 *
 * Given a conversation_id, fetches the first inbound message and enriches
 * sender info via Unipile (LinkedIn) or Claude Haiku signature parsing (email).
 *
 * POST { conversation_id: "uuid" }
 * Returns { first_name, last_name, email, phone, current_title, current_company, linkedin_url, location_text }
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

    const { conversation_id } = await req.json();
    if (!conversation_id) {
      return jsonResp({ error: 'conversation_id is required' }, 400);
    }

    // Get conversation channel
    const { data: convo, error: convoErr } = await supabase
      .from('conversations')
      .select('channel')
      .eq('id', conversation_id)
      .single();
    if (convoErr || !convo) {
      return jsonResp({ error: 'Conversation not found' }, 404);
    }

    // Get first inbound message
    const { data: msg } = await supabase
      .from('messages')
      .select('sender_name, sender_address, body, channel')
      .eq('conversation_id', conversation_id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (!msg) {
      return jsonResp({ error: 'No inbound messages found' }, 404);
    }

    const channel = convo.channel || msg.channel;
    const result: Record<string, string | null> = {
      first_name: null,
      last_name: null,
      email: null,
      phone: null,
      current_title: null,
      current_company: null,
      linkedin_url: null,
      location_text: null,
    };

    // Parse sender_name into first/last
    if (msg.sender_name) {
      const parts = msg.sender_name.trim().split(/\s+/);
      result.first_name = parts[0] || null;
      result.last_name = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }

    if (channel === 'linkedin') {
      await enrichFromLinkedIn(msg, result);
    } else if (channel === 'email') {
      result.email = msg.sender_address || null;
      await enrichFromEmailSignature(msg, result);
    } else if (channel === 'sms') {
      result.phone = msg.sender_address || null;
    }

    return jsonResp(result);
  } catch (err: any) {
    console.error('enrich-sender-from-inbox error:', err);
    return jsonResp({ error: err.message }, 500);
  }
});

// ── LinkedIn enrichment via Unipile ─────────────────────────────────────────

async function enrichFromLinkedIn(
  msg: { sender_address: string | null },
  result: Record<string, string | null>,
) {
  const unipileApiKey = Deno.env.get('UNIPILE_API_KEY');
  const unipileBaseUrl = Deno.env.get('UNIPILE_BASE_URL');
  if (!unipileApiKey || !unipileBaseUrl || !msg.sender_address) return;

  // sender_address may be a provider_id or LinkedIn slug
  const identifier = msg.sender_address;

  // Skip garbage slugs
  if (identifier.startsWith('ACo') || identifier.startsWith('acw')) return;

  try {
    const base = unipileBaseUrl.replace(/\/api\/v1\/?$/, '');
    const url = `${base}/api/v1/users/${encodeURIComponent(identifier)}`;
    const resp = await fetch(url, {
      headers: {
        'X-API-KEY': unipileApiKey,
        'Accept': 'application/json',
      },
    });

    if (!resp.ok) {
      console.warn(`Unipile profile lookup failed: ${resp.status}`);
      return;
    }

    const profile = await resp.json();

    // Name from profile (may be more accurate than message sender_name)
    if (profile.name) {
      const parts = profile.name.trim().split(/\s+/);
      result.first_name = parts[0] || result.first_name;
      result.last_name = parts.length > 1 ? parts.slice(1).join(' ') : result.last_name;
    }

    result.current_title = extractTitleFromProfile(profile);
    result.current_company = extractCompanyFromProfile(profile);

    // Construct LinkedIn URL from public_identifier
    const publicId = profile.public_identifier || profile.provider_id;
    if (publicId && !publicId.startsWith('ACo') && !publicId.startsWith('acw')) {
      result.linkedin_url = `https://www.linkedin.com/in/${publicId}`;
    }

    // Location
    if (profile.location) {
      result.location_text = typeof profile.location === 'string'
        ? profile.location
        : profile.location.name || null;
    }
  } catch (err: any) {
    console.warn('LinkedIn enrichment error:', err.message);
  }
}

// ── Email signature parsing via Claude Haiku ────────────────────────────────

async function enrichFromEmailSignature(
  msg: { body: string | null },
  result: Record<string, string | null>,
) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY') ?? Deno.env.get('anthropic_api_key') ?? '';
  if (!apiKey || !msg.body) return;

  // Strip HTML tags and normalize whitespace
  const plainText = msg.body
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (plainText.length < 20) return;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: `Extract contact information from the email signature at the bottom of this email. Return ONLY valid JSON with these fields (set to null if not found):
{
  "name": "full name from signature",
  "title": "job title",
  "company": "company name",
  "phone": "phone number",
  "location": "city/state/region"
}

Rules:
- Only extract from the signature block, not the email body
- If there is no clear signature, return all nulls
- For phone, include country code if present
- Do not infer or guess — only extract explicitly stated info`,
        messages: [{ role: 'user', content: plainText.slice(-2000) }],
        temperature: 0,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      console.warn('Signature extraction API error:', resp.status);
      return;
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    const sig = JSON.parse(jsonMatch[0]);

    // Only override name if we didn't already get it from sender_name
    if (sig.name && !result.first_name) {
      const parts = sig.name.trim().split(/\s+/);
      result.first_name = parts[0] || null;
      result.last_name = parts.length > 1 ? parts.slice(1).join(' ') : null;
    }

    if (sig.title) result.current_title = sig.title;
    if (sig.company) result.current_company = sig.company;
    if (sig.phone) result.phone = sig.phone;
    if (sig.location) result.location_text = sig.location;
  } catch (err: any) {
    console.warn('Signature extraction error:', err.message);
  }
}

// ── Profile extraction helpers (from backfill-companies pattern) ────────────

function extractCompanyFromProfile(p: any): string | null {
  const positions: any[] =
    p.positions ?? p.experience ?? p.work_experience ?? p.jobs ?? [];
  if (positions.length > 0) {
    const current = positions.find((pos: any) =>
      pos.is_current === true || pos.current === true || !pos.end_date
    ) ?? positions[0];
    const company = current?.company?.name ?? current?.company_name ?? current?.organization ?? null;
    if (company) return company;
  }

  const headline = p.headline ?? '';
  if (headline.includes(' at ')) {
    const parts = headline.split(' at ');
    const company = parts[parts.length - 1].trim();
    if (company && company.length > 1) return company;
  }

  for (const sep of [' | ', ' - ', ' — ']) {
    if (headline.includes(sep)) {
      const parts = headline.split(sep);
      if (parts.length >= 2) {
        const candidate = parts[parts.length - 1].trim();
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

  const headline = p.headline ?? '';
  if (headline.includes(' at ')) {
    return headline.split(' at ')[0].trim() || null;
  }

  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function jsonResp(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
