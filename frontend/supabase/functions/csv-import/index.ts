import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const VALID_CANDIDATE_STAGES = [
  'back_of_resume','pitch','send_out','submitted','interview',
  'first_round','second_round','third_plus_round','offer',
  'accepted','declined','counter_offer','disqualified',
];
const VALID_JOB_STAGES = ['lead','hot','offer_made','closed_won','closed_lost'];
const VALID_PRIORITIES = ['low','medium','high'];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });

  try {
    const { entity_type, rows, user_id } = await req.json();
    if (!entity_type || !rows?.length || !user_id) {
      return respond({ error: "entity_type, rows, and user_id are required" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    let inserted = 0, updated = 0, skipped = 0;

    if (entity_type === 'candidates') {
      // Collect all emails from the batch to prefetch existing records
      const emails = rows
        .map((r: any) => r.email?.toLowerCase().trim())
        .filter((e: string) => e && e.length > 0);

      const existingMap = new Map<string, string>(); // email -> id
      if (emails.length > 0) {
        const { data: existing } = await supabase
          .from('candidates')
          .select('id, email')
          .in('email', emails);
        for (const e of existing ?? []) {
          if (e.email) existingMap.set(e.email.toLowerCase().trim(), e.id);
        }
      }

      for (const r of rows) {
        try {
          const stage = r.stage ? r.stage.toLowerCase().replace(/\s/g, '_') : 'back_of_resume';
          const skills = r.skills ? r.skills.split(/[,;|]/).map((s: string) => s.trim()).filter(Boolean) : [];
          const emailKey = r.email?.toLowerCase().trim();
          const existingId = emailKey ? existingMap.get(emailKey) : null;

          if (existingId) {
            // Update existing — preserve stage/status, just refresh profile data
            const updateData: Record<string, any> = {
              first_name: r.first_name,
              last_name: r.last_name,
              full_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
              updated_at: new Date().toISOString(),
            };
            if (r.phone) updateData.phone = r.phone;
            if (r.current_title) updateData.current_title = r.current_title;
            if (r.current_company) updateData.current_company = r.current_company;
            if (r.linkedin_url) updateData.linkedin_url = r.linkedin_url;
            if (r.location_text) updateData.location_text = r.location_text;
            if (r.notes) updateData.notes = r.notes;

            const { error } = await supabase.from('candidates').update(updateData).eq('id', existingId);
            if (error) { console.error('update error:', error.message); skipped++; }
            else updated++;
          } else {
            // Insert new
            const insertData: Record<string, any> = {
              user_id,
              first_name: r.first_name,
              last_name: r.last_name,
              full_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
              email: r.email || '',
              stage: VALID_CANDIDATE_STAGES.includes(stage) ? stage : 'back_of_resume',
              status: 'new',
              skills,
            };
            if (r.phone) insertData.phone = r.phone;
            if (r.current_title) insertData.current_title = r.current_title;
            if (r.current_company) insertData.current_company = r.current_company;
            if (r.linkedin_url) insertData.linkedin_url = r.linkedin_url;
            if (r.location_text) insertData.location_text = r.location_text;
            if (r.source) insertData.source = r.source;
            if (r.notes) insertData.notes = r.notes;

            const { error } = await supabase.from('candidates').insert(insertData);
            if (error) { console.error('insert error:', error.message); skipped++; }
            else inserted++;
          }
        } catch (rowErr: any) {
          console.error('row error:', rowErr?.message);
          skipped++;
        }
      }

    } else if (entity_type === 'contacts') {
      const emails = rows
        .map((r: any) => r.email?.toLowerCase().trim())
        .filter((e: string) => e && e.length > 0);

      const existingMap = new Map<string, string>();
      if (emails.length > 0) {
        const { data: existing } = await supabase
          .from('contacts')
          .select('id, email')
          .in('email', emails);
        for (const e of existing ?? []) {
          if (e.email) existingMap.set(e.email.toLowerCase().trim(), e.id);
        }
      }

      for (const r of rows) {
        try {
          const emailKey = r.email?.toLowerCase().trim();
          const existingId = emailKey ? existingMap.get(emailKey) : null;

          if (existingId) {
            const updateData: Record<string, any> = {
              first_name: r.first_name,
              last_name: r.last_name,
              full_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
              updated_at: new Date().toISOString(),
            };
            if (r.phone) updateData.phone = r.phone;
            if (r.title) updateData.title = r.title;
            if (r.company_name) updateData.company_name = r.company_name;
            if (r.linkedin_url) updateData.linkedin_url = r.linkedin_url;
            if (r.notes) updateData.notes = r.notes;

            const { error } = await supabase.from('contacts').update(updateData).eq('id', existingId);
            if (error) { skipped++; } else updated++;
          } else {
            const insertData: Record<string, any> = {
              user_id,
              first_name: r.first_name,
              last_name: r.last_name,
              full_name: [r.first_name, r.last_name].filter(Boolean).join(' '),
              email: r.email || '',
            };
            if (r.phone) insertData.phone = r.phone;
            if (r.title) insertData.title = r.title;
            if (r.company_name) insertData.company_name = r.company_name;
            if (r.linkedin_url) insertData.linkedin_url = r.linkedin_url;
            if (r.notes) insertData.notes = r.notes;

            const { error } = await supabase.from('contacts').insert(insertData);
            if (error) { skipped++; } else inserted++;
          }
        } catch { skipped++; }
      }

    } else if (entity_type === 'jobs') {
      for (const r of rows) {
        try {
          const stage = r.stage ? r.stage.toLowerCase().replace(/\s/g, '_') : 'lead';
          const priority = r.priority ? r.priority.toLowerCase() : 'medium';
          const insertData: Record<string, any> = {
            user_id,
            title: r.title || '',
            company: r.company || '',
            location: r.location || '',
            status: VALID_JOB_STAGES.includes(stage) ? stage : 'lead',
            priority: VALID_PRIORITIES.includes(priority) ? priority : 'medium',
          };
          if (r.salary) insertData.salary = r.salary;
          if (r.hiring_manager) insertData.hiring_manager = r.hiring_manager;
          if (r.notes) insertData.notes = r.notes;

          const { error } = await supabase.from('jobs').insert(insertData);
          if (error) { skipped++; } else inserted++;
        } catch { skipped++; }
      }
    } else {
      return respond({ error: `Unknown entity_type: ${entity_type}` }, 400);
    }

    return respond({ success: true, inserted, updated, skipped, total: rows.length });

  } catch (err: any) {
    console.error('[csv-import] fatal:', err?.message);
    return respond({ error: err?.message ?? 'Unknown error' }, 500);
  }
});
