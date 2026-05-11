import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/people/bytemine-enrich
 *
 * Enrich one or more people via Bytemine's `/contacts/enrich` endpoint
 * (work email focus). Looks up each person's LinkedIn URL → calls
 * Bytemine → writes the freshest fields back to `people`.
 *
 *   Body: { peopleIds: string[] }
 *   Auth: Supabase JWT (user-initiated from the app)
 *
 * Per-person write rules:
 *   - work_email      ← response.work_email
 *   - personal_email  ← response.personal_email
 *   - mobile_phone    ← response.phone_cell || response.cell_phone
 *                       (falls back to phone if mobile_phone is empty)
 *   - current_title   ← response.title / job_title          (only if different)
 *   - current_company ← response.company_name / company     (only if different)
 *   - location_text   ← response.state || response.city     (only if empty)
 *   - primary_email   ← work_email when present (so downstream sequences
 *                       send to the verified work address by default)
 *   - email_invalid   ← false when work_email changed       (a fresh
 *                       address resets the bounce gate)
 *
 * Returns: { results: Array<{ id, ok, error?, updated?: string[] }> }.
 * Never throws on a single-person failure — collects per-row results
 * so the caller can show "21 of 32 succeeded" instead of failing the
 * whole batch.
 */

const BYTEMINE_URL =
  "https://bvjmtgaxijpyasjtaqiv.supabase.co/functions/v1/api-gateway";

interface BytemineResponse {
  work_email?: string | null;
  personal_email?: string | null;
  phone?: string | null;
  phone_cell?: string | null;
  cell_phone?: string | null;
  mobile_phone?: string | null;
  title?: string | null;
  job_title?: string | null;
  company?: string | null;
  company_name?: string | null;
  state?: string | null;
  city?: string | null;
  // Bytemine also returns a `contact` envelope in some cases.
  contact?: BytemineResponse;
}

function flatten(b: BytemineResponse | null | undefined): BytemineResponse {
  if (!b) return {};
  // Some shapes wrap the data in a `contact` field; unwrap once.
  return b.contact ? { ...b.contact } : { ...b };
}

async function callBytemine(linkedin: string, token: string): Promise<BytemineResponse | null> {
  const resp = await fetch(BYTEMINE_URL, {
    method: "POST",
    headers: {
      "x-amz-security-token": token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      path: "/contacts/enrich",
      method: "POST",
      body: { linkedin },
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Bytemine ${resp.status}: ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as BytemineResponse;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // Auth: Supabase JWT (user-initiated) OR service-role key (admin scripts).
  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  let actingUserId: string | null = null;
  if (authHeader === serviceKey) {
    actingUserId = null; // admin path
  } else {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
    actingUserId = user.id;
  }

  // Bytemine token: env first, then app_settings.
  let token = process.env.BYTEMINE_API_KEY || "";
  if (!token) {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "BYTEMINE_API_KEY")
      .maybeSingle();
    token = (data as any)?.value || "";
  }
  if (!token) {
    return res.status(500).json({ error: "BYTEMINE_API_KEY not configured" });
  }

  const peopleIds: string[] = Array.isArray(req.body?.peopleIds) ? req.body.peopleIds : [];
  if (peopleIds.length === 0) {
    return res.status(400).json({ error: "peopleIds[] required" });
  }
  if (peopleIds.length > 100) {
    return res.status(400).json({ error: "Max 100 per request" });
  }

  // Pull every target person upfront — saves N round-trips.
  const { data: rows, error: peopleErr } = await supabase
    .from("people")
    .select("id, linkedin_url, work_email, personal_email, primary_email, mobile_phone, phone, current_title, current_company, location_text, email_invalid")
    .in("id", peopleIds);
  if (peopleErr) {
    return res.status(500).json({ error: `people lookup failed: ${peopleErr.message}` });
  }

  const byId = new Map<string, any>((rows ?? []).map((r) => [r.id, r]));
  const results: Array<{ id: string; ok: boolean; error?: string; updated?: string[] }> = [];

  for (const id of peopleIds) {
    const row = byId.get(id);
    if (!row) {
      results.push({ id, ok: false, error: "person not found" });
      continue;
    }
    if (!row.linkedin_url) {
      results.push({ id, ok: false, error: "no linkedin_url" });
      continue;
    }

    try {
      const raw = await callBytemine(row.linkedin_url, token);
      const data = flatten(raw);

      // Only patch fields that actually came back AND differ from what
      // we already have. Reduces noise + preserves manual overrides.
      const updates: Record<string, any> = {};
      const updatedFields: string[] = [];

      const workEmail = (data.work_email ?? "").trim().toLowerCase() || null;
      if (workEmail && workEmail !== (row.work_email ?? "").toLowerCase()) {
        updates.work_email = workEmail;
        updatedFields.push("work_email");
        // Promote to primary when we have a verified work address; the
        // sequence engine sends to primary_email.
        updates.primary_email = workEmail;
        updatedFields.push("primary_email");
        // Fresh address — clear the bounce flag from the old one.
        if (row.email_invalid) {
          updates.email_invalid = false;
          updates.email_invalid_at = null;
          updates.email_invalid_reason = null;
          updatedFields.push("email_invalid");
        }
      }

      const personalEmail = (data.personal_email ?? "").trim().toLowerCase() || null;
      if (personalEmail && personalEmail !== (row.personal_email ?? "").toLowerCase()) {
        updates.personal_email = personalEmail;
        updatedFields.push("personal_email");
      }

      const cell =
        (data.phone_cell ?? data.cell_phone ?? data.mobile_phone ?? data.phone ?? "").toString().trim() || null;
      if (cell) {
        // Prefer mobile_phone slot when empty; fall back to phone slot.
        if (!row.mobile_phone) {
          updates.mobile_phone = cell;
          updatedFields.push("mobile_phone");
        } else if (!row.phone) {
          updates.phone = cell;
          updatedFields.push("phone");
        }
      }

      const title = (data.title ?? data.job_title ?? "").trim() || null;
      if (title && title !== (row.current_title ?? "")) {
        updates.current_title = title;
        updatedFields.push("current_title");
      }

      const company = (data.company_name ?? data.company ?? "").trim() || null;
      if (company && company !== (row.current_company ?? "")) {
        updates.current_company = company;
        updatedFields.push("current_company");
      }

      // State preferred over city per the spec ("location put states").
      const location = (data.state ?? data.city ?? "").trim() || null;
      if (location && !row.location_text) {
        updates.location_text = location;
        updatedFields.push("location_text");
      }

      if (Object.keys(updates).length === 0) {
        results.push({ id, ok: true, updated: [] });
        continue;
      }

      updates.updated_at = new Date().toISOString();
      const { error: updErr } = await supabase
        .from("people")
        .update(updates)
        .eq("id", id);
      if (updErr) {
        results.push({ id, ok: false, error: `update failed: ${updErr.message}` });
        continue;
      }
      results.push({ id, ok: true, updated: updatedFields });
    } catch (err: any) {
      results.push({ id, ok: false, error: err?.message || "bytemine call failed" });
    }
  }

  return res.status(200).json({
    results,
    actingUserId,
    counts: {
      total: peopleIds.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      no_linkedin: results.filter((r) => r.error === "no linkedin_url").length,
    },
  });
}
