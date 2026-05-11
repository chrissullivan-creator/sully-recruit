import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/people/enrich
 *
 * Enrich one or more people with verified contact info. Multi-provider
 * cascade per requested field — LeadMagic first (cheaper, validated),
 * Bytemine as fallback. The recruiter picks which fields to spend
 * credits on via `fields[]`, so we never call APIs for slots they
 * don't care about.
 *
 *   Body: {
 *     peopleIds: string[],                // up to 100
 *     fields:    Array<'work_email' | 'personal_email' | 'mobile'>
 *   }
 *
 * Per-field cascade:
 *
 *   work_email:
 *     1. LeadMagic /v1/people/b2b-profile-email   (5 cr if found, free if not)
 *     2. Bytemine  /contacts/enrich               (LinkedIn lookup)
 *     ──> validate the resulting address via /v1/people/email-validation
 *         (0.25 cr) so we don't write a known-bad address back.
 *
 *   personal_email:
 *     1. LeadMagic /v1/people/personal-email-finder  (2 cr if found)
 *     2. Bytemine  /contacts/enrich                  (rarely returns
 *        personal — but cheap fallback)
 *
 *   mobile:
 *     1. LeadMagic /v1/people/mobile-finder       (5 cr if found)
 *     2. Bytemine  /contacts/enrich
 *
 * Per-person writes (only fields that came back AND differ):
 *   work_email      → people.work_email + people.primary_email
 *                     (clears email_invalid when work_email changes)
 *   personal_email  → people.personal_email
 *   mobile          → people.mobile_phone (falls back to phone)
 *   current_company → only updated if Bytemine returns one and ours
 *                     is empty (LeadMagic doesn't reliably return this)
 *   current_title   → same logic
 *   location_text   → same logic
 *
 * Returns per-person results so a single bad row doesn't fail the
 * batch. `credits` totals each provider's spend for the call so the
 * caller can show "spent N credits" feedback.
 */

const LEADMAGIC_BASE = "https://api.leadmagic.io";
const BYTEMINE_URL =
  "https://bvjmtgaxijpyasjtaqiv.supabase.co/functions/v1/api-gateway";

type Field = "work_email" | "personal_email" | "mobile";

interface EnrichResult {
  id: string;
  ok: boolean;
  error?: string;
  updated: string[];
  source?: Partial<Record<Field, "leadmagic" | "bytemine" | "none">>;
}

interface BytemineFlat {
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
}

function asLinkedinSlug(url: string): string | null {
  if (!url) return null;
  const m = url.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  return m?.[1] ?? null;
}

async function leadmagicCall<T>(
  path: string,
  body: any,
  apiKey: string,
): Promise<{ data: T | null; credits: number }> {
  const resp = await fetch(`${LEADMAGIC_BASE}${path}`, {
    method: "POST",
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    // 402 = no credits, 429 = rate limit. Treat as "no result" so the
    // cascade falls through to Bytemine.
    return { data: null, credits: 0 };
  }
  const json = await resp.json();
  const credits = Number(json?.credits_consumed ?? 0);
  return { data: json as T, credits };
}

async function bytemineEnrich(
  linkedin: string,
  token: string,
): Promise<BytemineFlat | null> {
  try {
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
    if (!resp.ok) return null;
    const raw = (await resp.json()) as any;
    return raw?.contact ? raw.contact : raw;
  } catch {
    return null;
  }
}

async function validateEmail(
  email: string,
  apiKey: string,
): Promise<{ status: string; credits: number }> {
  const { data, credits } = await leadmagicCall<{ email_status: string }>(
    "/v1/people/email-validation",
    { email },
    apiKey,
  );
  return { status: data?.email_status ?? "unknown", credits };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const authHeader = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!authHeader) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  if (authHeader !== serviceKey) {
    const { data: { user }, error: authErr } = await supabase.auth.getUser(authHeader);
    if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });
  }

  // Provider keys: env first, app_settings fallback.
  let bytemineKey = process.env.BYTEMINE_API_KEY || "";
  let leadmagicKey = process.env.LEADMAGIC_API_KEY || "";
  if (!bytemineKey || !leadmagicKey) {
    const { data } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["BYTEMINE_API_KEY", "LEADMAGIC_API_KEY"]);
    for (const row of data ?? []) {
      if (row.key === "BYTEMINE_API_KEY" && !bytemineKey) bytemineKey = row.value;
      if (row.key === "LEADMAGIC_API_KEY" && !leadmagicKey) leadmagicKey = row.value;
    }
  }
  if (!bytemineKey && !leadmagicKey) {
    return res.status(500).json({ error: "Neither BYTEMINE_API_KEY nor LEADMAGIC_API_KEY configured" });
  }

  const peopleIds: string[] = Array.isArray(req.body?.peopleIds) ? req.body.peopleIds : [];
  const fields: Field[] = Array.isArray(req.body?.fields) ? req.body.fields : ["work_email"];
  if (peopleIds.length === 0) return res.status(400).json({ error: "peopleIds[] required" });
  if (peopleIds.length > 100) return res.status(400).json({ error: "Max 100 per request" });
  if (fields.length === 0) return res.status(400).json({ error: "fields[] required" });

  const { data: rows, error: peopleErr } = await supabase
    .from("people")
    .select("id, linkedin_url, work_email, personal_email, primary_email, mobile_phone, phone, current_title, current_company, location_text, email_invalid, first_name, last_name")
    .in("id", peopleIds);
  if (peopleErr) return res.status(500).json({ error: `people lookup failed: ${peopleErr.message}` });

  const byId = new Map<string, any>((rows ?? []).map((r) => [r.id, r]));
  const results: EnrichResult[] = [];
  const credits = { leadmagic: 0, bytemine_calls: 0 };

  for (const id of peopleIds) {
    const row = byId.get(id);
    if (!row) {
      results.push({ id, ok: false, error: "person not found", updated: [] });
      continue;
    }
    if (!row.linkedin_url) {
      results.push({ id, ok: false, error: "no linkedin_url", updated: [] });
      continue;
    }

    const slug = asLinkedinSlug(row.linkedin_url);
    const profileUrl = slug ?? row.linkedin_url;

    const updates: Record<string, any> = {};
    const updated: string[] = [];
    const source: EnrichResult["source"] = {};

    // Lazy Bytemine response — fetched at most once per person and only
    // if at least one cascade step actually needs it.
    let bytemineCache: BytemineFlat | null | undefined;
    const getBytemine = async () => {
      if (bytemineCache !== undefined) return bytemineCache;
      if (!bytemineKey) {
        bytemineCache = null;
        return null;
      }
      bytemineCache = await bytemineEnrich(row.linkedin_url, bytemineKey);
      credits.bytemine_calls += 1;
      return bytemineCache;
    };

    // ── work_email ───────────────────────────────────────────────
    if (fields.includes("work_email")) {
      let workEmail: string | null = null;
      if (leadmagicKey) {
        const { data, credits: c } = await leadmagicCall<{ email?: string }>(
          "/v1/people/b2b-profile-email",
          { profile_url: profileUrl },
          leadmagicKey,
        );
        credits.leadmagic += c;
        if (data?.email) {
          workEmail = data.email.toLowerCase();
          source.work_email = "leadmagic";
        }
      }
      if (!workEmail) {
        const bm = await getBytemine();
        if (bm?.work_email) {
          workEmail = bm.work_email.toLowerCase();
          source.work_email = "bytemine";
        }
      }

      if (workEmail) {
        // Verify before writing — don't replace a bounced address with
        // another bounced address. unknown/valid both pass; only block
        // explicit `invalid`.
        let okToWrite = true;
        if (leadmagicKey) {
          const { status, credits: c } = await validateEmail(workEmail, leadmagicKey);
          credits.leadmagic += c;
          if (status === "invalid") okToWrite = false;
        }
        if (okToWrite && workEmail !== (row.work_email ?? "").toLowerCase()) {
          updates.work_email = workEmail;
          updates.primary_email = workEmail;
          updated.push("work_email", "primary_email");
          if (row.email_invalid) {
            updates.email_invalid = false;
            updates.email_invalid_at = null;
            updates.email_invalid_reason = null;
            updated.push("email_invalid");
          }
        }
      }
      if (!source.work_email) source.work_email = "none";
    }

    // ── personal_email ───────────────────────────────────────────
    if (fields.includes("personal_email")) {
      let personal: string | null = null;
      if (leadmagicKey) {
        const { data, credits: c } = await leadmagicCall<{
          first_personal_email?: string; personal_emails?: string[];
        }>("/v1/people/personal-email-finder", { profile_url: profileUrl }, leadmagicKey);
        credits.leadmagic += c;
        const found = data?.first_personal_email || data?.personal_emails?.[0];
        if (found) {
          personal = found.toLowerCase();
          source.personal_email = "leadmagic";
        }
      }
      if (!personal) {
        const bm = await getBytemine();
        if (bm?.personal_email) {
          personal = bm.personal_email.toLowerCase();
          source.personal_email = "bytemine";
        }
      }
      if (personal && personal !== (row.personal_email ?? "").toLowerCase()) {
        updates.personal_email = personal;
        updated.push("personal_email");
      }
      if (!source.personal_email) source.personal_email = "none";
    }

    // ── mobile ───────────────────────────────────────────────────
    if (fields.includes("mobile")) {
      let mobile: string | null = null;
      if (leadmagicKey) {
        const body: any = { profile_url: profileUrl };
        if (row.work_email) body.work_email = row.work_email;
        if (row.personal_email) body.personal_email = row.personal_email;
        const { data, credits: c } = await leadmagicCall<{ mobile_number?: string }>(
          "/v1/people/mobile-finder", body, leadmagicKey,
        );
        credits.leadmagic += c;
        if (data?.mobile_number) {
          mobile = data.mobile_number;
          source.mobile = "leadmagic";
        }
      }
      if (!mobile) {
        const bm = await getBytemine();
        const cell = bm?.phone_cell ?? bm?.cell_phone ?? bm?.mobile_phone ?? bm?.phone ?? null;
        if (cell) {
          mobile = String(cell);
          source.mobile = "bytemine";
        }
      }
      if (mobile) {
        // Prefer mobile_phone slot when empty; fall back to phone.
        if (!row.mobile_phone) {
          updates.mobile_phone = mobile;
          updated.push("mobile_phone");
        } else if (!row.phone) {
          updates.phone = mobile;
          updated.push("phone");
        }
      }
      if (!source.mobile) source.mobile = "none";
    }

    // ── opportunistic profile fields from Bytemine if we already
    //    pulled it — current_title / current_company / location.
    //    Cheap because no extra API call.
    if (bytemineCache) {
      const bm = bytemineCache;
      const title = (bm.title ?? bm.job_title ?? "").trim();
      if (title && title !== (row.current_title ?? "")) {
        updates.current_title = title;
        updated.push("current_title");
      }
      const company = (bm.company_name ?? bm.company ?? "").trim();
      if (company && company !== (row.current_company ?? "")) {
        updates.current_company = company;
        updated.push("current_company");
      }
      const loc = (bm.state ?? bm.city ?? "").trim();
      if (loc && !row.location_text) {
        updates.location_text = loc;
        updated.push("location_text");
      }
    }

    if (Object.keys(updates).length === 0) {
      results.push({ id, ok: true, updated: [], source });
      continue;
    }

    updates.updated_at = new Date().toISOString();
    const { error: updErr } = await supabase
      .from("people").update(updates).eq("id", id);
    if (updErr) {
      results.push({ id, ok: false, error: `update failed: ${updErr.message}`, updated: [], source });
      continue;
    }
    results.push({ id, ok: true, updated, source });
  }

  return res.status(200).json({
    results,
    credits,
    counts: {
      total: peopleIds.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      no_linkedin: results.filter((r) => r.error === "no linkedin_url").length,
      changed: results.filter((r) => r.updated.length > 0).length,
    },
  });
}
