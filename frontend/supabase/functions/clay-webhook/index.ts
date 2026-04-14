import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Restrict CORS to Clay's webhook origin. Clay webhooks are server-to-server
// so CORS isn't strictly needed, but we keep it for preflight requests.
const corsHeaders = {
  "Access-Control-Allow-Origin": "https://app.clay.com",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-clay-secret, x-webhook-secret",
};

function extractField(
  row: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const val = row[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

/**
 * clay-webhook
 *
 * Receives enriched contact/candidate data from Clay.
 * Clay POSTs a JSON array (or single object) with a `sully_id` field
 * formatted as "candidate::<uuid>" or "contact::<uuid>".
 * Only null fields are filled — existing data is never overwritten.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Optional: verify shared secret
    const { data: secretRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "CLAY_WEBHOOK_SECRET")
      .maybeSingle();

    if (secretRow?.value) {
      const headerSecret =
        req.headers.get("x-clay-secret") ||
        req.headers.get("x-webhook-secret");
      if (headerSecret !== secretRow.value) {
        return new Response(JSON.stringify({ error: "Invalid secret" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const body = await req.json();

    // Clay may send a single row or an array
    const rows: Record<string, unknown>[] = Array.isArray(body)
      ? body
      : body?.rows ?? body?.data ?? [body];

    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      const sullyId =
        (row.sully_id as string) ||
        (row.sullyId as string) ||
        (row.sully_record_id as string);

      if (!sullyId || typeof sullyId !== "string") {
        skipped++;
        continue;
      }

      const [entityType, entityId] = sullyId.split("::");
      if (!entityType || !entityId) {
        skipped++;
        continue;
      }

      if (entityType === "candidate") {
        const { data: existing } = await supabase
          .from("candidates")
          .select(
            "email, phone, linkedin_url, current_title, current_company, location_text"
          )
          .eq("id", entityId)
          .single();

        if (!existing) {
          skipped++;
          continue;
        }

        const updates: Record<string, string> = {};
        if (!existing.email) {
          const v = extractField(row, "personal_email", "email", "work_email");
          if (v) updates.email = v;
        }
        if (!existing.phone) {
          const v = extractField(row, "mobile_phone", "phone", "personal_phone");
          if (v) updates.phone = v;
        }
        if (!existing.linkedin_url) {
          const v = extractField(row, "linkedin_url", "linkedin_profile_url", "linkedinUrl");
          if (v) updates.linkedin_url = v;
        }
        if (!existing.current_title) {
          const v = extractField(row, "title", "job_title", "current_title");
          if (v) updates.current_title = v;
        }
        if (!existing.current_company) {
          const v = extractField(row, "company", "company_name", "current_company");
          if (v) updates.current_company = v;
        }
        if (!existing.location_text) {
          const v = extractField(row, "location", "city", "location_text");
          if (v) updates.location_text = v;
        }

        if (Object.keys(updates).length > 0) {
          await supabase
            .from("candidates")
            .update(updates)
            .eq("id", entityId);
          updated++;
        } else {
          skipped++;
        }
      } else if (entityType === "contact") {
        const { data: existing } = await supabase
          .from("contacts")
          .select("email, phone, linkedin_url, title, department")
          .eq("id", entityId)
          .single();

        if (!existing) {
          skipped++;
          continue;
        }

        const updates: Record<string, string> = {};
        if (!existing.email) {
          const v = extractField(row, "Work Email", "work_email", "email", "personal_email");
          if (v) updates.email = v;
        }
        if (!existing.phone) {
          const v = extractField(row, "phone", "work_phone", "mobile_phone");
          if (v) updates.phone = v;
        }
        if (!existing.linkedin_url) {
          const v = extractField(row, "linkedin_url", "linkedin_profile_url", "linkedinUrl");
          if (v) updates.linkedin_url = v;
        }
        if (!existing.title) {
          const v = extractField(row, "title", "job_title");
          if (v) updates.title = v;
        }
        if (!existing.department) {
          const v = extractField(row, "department");
          if (v) updates.department = v;
        }

        if (Object.keys(updates).length > 0) {
          await supabase.from("contacts").update(updates).eq("id", entityId);
          updated++;
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    }

    return new Response(
      JSON.stringify({ received: true, updated, skipped }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
