import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * /api/schedule-links — CRUD for the signed-in recruiter's own scheduling
 * link(s). Auth via Supabase JWT (Authorization: Bearer <token>).
 *
 *   GET   → return the caller's links (array).
 *   POST  → create a link. Slug is auto-generated from the caller's name on
 *           first create (deduped). The Outlook account defaults to the
 *           caller's active email integration_account when not supplied.
 *   PATCH → update the caller's link (by id, or their only link). Allowed
 *           fields: title, duration_min, meeting_type, location, timezone,
 *           working_hours, buffer_min, min_notice_hours, max_days_out,
 *           active, integration_account_id.
 *
 * Uses the service-role client but always scopes writes/reads to the JWT
 * user's id, so RLS is mirrored in code.
 */

const ALLOWED_MEETING_TYPES = new Set(["phone", "teams", "in_person"]);

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "link"
  );
}

/** Pick only the columns a caller is allowed to set, validating as we go. */
function pickUpdatableFields(body: any): { fields: Record<string, any>; error?: string } {
  const fields: Record<string, any> = {};
  if (body.title !== undefined) fields.title = body.title === null ? null : String(body.title).slice(0, 200);
  if (body.location !== undefined)
    fields.location = body.location === null ? null : String(body.location).slice(0, 300);
  if (body.timezone !== undefined) fields.timezone = String(body.timezone).slice(0, 64);
  if (body.meeting_type !== undefined) {
    if (!ALLOWED_MEETING_TYPES.has(body.meeting_type)) {
      return { fields, error: "meeting_type must be phone, teams, or in_person" };
    }
    fields.meeting_type = body.meeting_type;
  }
  if (body.duration_min !== undefined) {
    const v = parseInt(body.duration_min, 10);
    if (!Number.isFinite(v) || v < 5 || v > 480) return { fields, error: "duration_min must be 5–480" };
    fields.duration_min = v;
  }
  if (body.buffer_min !== undefined) {
    const v = parseInt(body.buffer_min, 10);
    if (!Number.isFinite(v) || v < 0 || v > 240) return { fields, error: "buffer_min must be 0–240" };
    fields.buffer_min = v;
  }
  if (body.min_notice_hours !== undefined) {
    const v = parseInt(body.min_notice_hours, 10);
    if (!Number.isFinite(v) || v < 0 || v > 720) return { fields, error: "min_notice_hours must be 0–720" };
    fields.min_notice_hours = v;
  }
  if (body.max_days_out !== undefined) {
    const v = parseInt(body.max_days_out, 10);
    if (!Number.isFinite(v) || v < 1 || v > 365) return { fields, error: "max_days_out must be 1–365" };
    fields.max_days_out = v;
  }
  if (body.active !== undefined) fields.active = !!body.active;
  if (body.working_hours !== undefined && body.working_hours !== null) {
    if (typeof body.working_hours !== "object") return { fields, error: "working_hours must be an object" };
    fields.working_hours = body.working_hours;
  }
  if (body.integration_account_id !== undefined) {
    fields.integration_account_id = body.integration_account_id || null;
  }
  return { fields };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const supabase = createClient(supabaseUrl, serviceKey);
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: "Unauthorized" });

  try {
    // ── GET — list the caller's links ──────────────────────────────────
    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("scheduling_links")
        .select("*")
        .eq("owner_user_id", user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.status(200).json({ links: data || [] });
    }

    // ── POST — create a link with an auto slug ─────────────────────────
    if (req.method === "POST") {
      // Derive the base slug from the caller's display name (profiles →
      // user_metadata → email local-part).
      const { data: profile } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("id", user.id)
        .maybeSingle();
      const displayName =
        profile?.full_name ||
        (user.user_metadata as any)?.full_name ||
        (user.email ? user.email.split("@")[0] : "") ||
        "link";
      const base = slugify(displayName);

      // Dedup the slug against existing links.
      const { data: clashes } = await supabase
        .from("scheduling_links")
        .select("slug")
        .ilike("slug", `${base}%`);
      const taken = new Set((clashes || []).map((r: any) => r.slug));
      let slug = base;
      let n = 1;
      while (taken.has(slug)) slug = `${base}-${++n}`;

      // Default the Outlook account to the caller's active email account.
      let integrationAccountId: string | null = req.body?.integration_account_id || null;
      if (!integrationAccountId) {
        const { data: acct } = await supabase
          .from("integration_accounts")
          .select("id")
          .eq("owner_user_id", user.id)
          .in("provider", ["email", "microsoft"])
          .eq("is_active", true)
          .not("email_address", "is", null)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        integrationAccountId = acct?.id || null;
      }

      const { fields, error: pickErr } = pickUpdatableFields(req.body || {});
      if (pickErr) return res.status(400).json({ error: pickErr });

      const insertPayload: Record<string, any> = {
        owner_user_id: user.id,
        integration_account_id: integrationAccountId,
        slug,
        title: fields.title ?? `Meeting with ${displayName}`,
        ...fields,
      };

      const { data: row, error } = await supabase
        .from("scheduling_links")
        .insert(insertPayload as any)
        .select("*")
        .single();
      if (error) throw error;
      return res.status(200).json({ link: row });
    }

    // ── PATCH — update the caller's link ───────────────────────────────
    if (req.method === "PATCH") {
      const { id, slug: newSlug } = req.body || {};

      // Resolve the target link id, always scoped to the caller.
      let targetId: string | null = id || null;
      if (!targetId) {
        const { data: links } = await supabase
          .from("scheduling_links")
          .select("id")
          .eq("owner_user_id", user.id)
          .order("created_at", { ascending: true });
        if (!links || links.length === 0) {
          return res.status(404).json({ error: "No scheduling link to update — create one first." });
        }
        if (links.length > 1) {
          return res.status(400).json({ error: "Multiple links — pass `id` to specify which to update." });
        }
        targetId = links[0].id;
      }

      const { fields, error: pickErr } = pickUpdatableFields(req.body || {});
      if (pickErr) return res.status(400).json({ error: pickErr });

      // Allow renaming the slug (validated + uniqueness-checked).
      if (newSlug !== undefined && newSlug !== null && String(newSlug).trim()) {
        const cleaned = slugify(String(newSlug));
        const { data: clash } = await supabase
          .from("scheduling_links")
          .select("id")
          .eq("slug", cleaned)
          .neq("id", targetId)
          .maybeSingle();
        if (clash) return res.status(409).json({ error: "That slug is already taken." });
        fields.slug = cleaned;
      }

      if (Object.keys(fields).length === 0) {
        return res.status(400).json({ error: "No updatable fields supplied" });
      }

      const { data: row, error } = await supabase
        .from("scheduling_links")
        .update(fields as any)
        .eq("id", targetId)
        .eq("owner_user_id", user.id) // mirror RLS in code
        .select("*")
        .single();
      if (error) throw error;
      return res.status(200).json({ link: row });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err: any) {
    console.error("schedule-links error:", err.message);
    return res.status(500).json({ error: err.message || "Request failed" });
  }
}
