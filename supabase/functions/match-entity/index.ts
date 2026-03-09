import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { email, phone, linkedin_profile_id, provider_id } = await req.json();

    console.log('Matching entity with:', { email, phone, linkedin_profile_id, provider_id });

    const matches = [];

    // Match by email
    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      
      const [candidateRes, prospectRes, contactRes] = await Promise.all([
        supabase.from('candidates').select('id, full_name, email').ilike('email', normalizedEmail).limit(5),
        supabase.from('prospects').select('id, full_name, email').ilike('email', normalizedEmail).limit(5),
        supabase.from('contacts').select('id, full_name, email').ilike('email', normalizedEmail).limit(5),
      ]);

      if (candidateRes.data) {
        matches.push(...candidateRes.data.map(c => ({ ...c, entity_type: 'candidate', match_by: 'email' })));
      }
      if (prospectRes.data) {
        matches.push(...prospectRes.data.map(p => ({ ...p, entity_type: 'prospect', match_by: 'email' })));
      }
      if (contactRes.data) {
        matches.push(...contactRes.data.map(c => ({ ...c, entity_type: 'contact', match_by: 'email' })));
      }
    }

    // Match by phone
    if (phone && matches.length === 0) {
      const normalizedPhone = phone.replace(/[^0-9+]/g, '');
      
      const [candidateRes, prospectRes, contactRes] = await Promise.all([
        supabase.from('candidates').select('id, full_name, phone').not('phone', 'is', null),
        supabase.from('prospects').select('id, full_name, phone').not('phone', 'is', null),
        supabase.from('contacts').select('id, full_name, phone').not('phone', 'is', null),
      ]);

      const normalize = (p: string) => p.replace(/[^0-9+]/g, '');
      const candidateMatch = candidateRes.data?.find(c => c.phone && normalize(c.phone) === normalizedPhone);
      const prospectMatch = prospectRes.data?.find(p => p.phone && normalize(p.phone) === normalizedPhone);
      const contactMatch = contactRes.data?.find(c => c.phone && normalize(c.phone) === normalizedPhone);

      if (candidateMatch) matches.push({ ...candidateMatch, entity_type: 'candidate', match_by: 'phone' });
      if (prospectMatch) matches.push({ ...prospectMatch, entity_type: 'prospect', match_by: 'phone' });
      if (contactMatch) matches.push({ ...contactMatch, entity_type: 'contact', match_by: 'phone' });
    }

    // Match by LinkedIn provider ID
    if (linkedin_profile_id && matches.length === 0) {
      // Check candidate_channels
      const { data: candidateChannelData } = await supabase
        .from('candidate_channels')
        .select('candidate_id, candidates(id, full_name)')
        .eq('provider_public_id', linkedin_profile_id)
        .eq('channel', 'linkedin')
        .limit(1)
        .single();

      if (candidateChannelData) {
        matches.push({
          id: candidateChannelData.candidate_id,
          full_name: (candidateChannelData as any).candidates?.full_name,
          entity_type: 'candidate',
          match_by: 'linkedin_profile_id',
        });
      }

      // Check contact_channels
      if (matches.length === 0) {
        const { data: contactChannelData } = await supabase
          .from('contact_channels')
          .select('contact_id, contacts(id, full_name)')
          .eq('provider_public_id', linkedin_profile_id)
          .eq('channel', 'linkedin')
          .limit(1)
          .single();

        if (contactChannelData) {
          matches.push({
            id: contactChannelData.contact_id,
            full_name: (contactChannelData as any).contacts?.full_name,
            entity_type: 'contact',
            match_by: 'linkedin_profile_id',
          });
        }
      }
    }

    // Determine result
    let result;
    if (matches.length === 0) {
      result = {
        matched: false,
        entity_type: null,
        entity_id: null,
        entity_name: null,
        needs_review: false,
        possible_matches: [],
      };
    } else if (matches.length === 1) {
      result = {
        matched: true,
        entity_type: matches[0].entity_type,
        entity_id: matches[0].id,
        entity_name: matches[0].full_name,
        needs_review: false,
        match_by: matches[0].match_by,
        possible_matches: [],
      };
    } else {
      // Multiple matches - needs manual review
      result = {
        matched: false,
        entity_type: null,
        entity_id: null,
        entity_name: null,
        needs_review: true,
        possible_matches: matches.map(m => ({
          entity_type: m.entity_type,
          entity_id: m.id,
          entity_name: m.full_name,
          match_by: m.match_by,
        })),
      };
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Error matching entity:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
