import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireAuth } from "./lib/auth.js";

/**
 * POST /api/import-people
 *
 * Bulk-imports rows from a CSV into the unified `people` table. Mirrors the
 * dedupe + dual-role behaviour of /api/add-person, but processes up to
 * MAX_ROWS rows per request, chunked internally so we don't hold a huge
 * transaction open or blow Vercel's 60s budget.
 *
 * Per row:
 *   - Match an existing person by ANY stored email (primary_email /
 *     personal_email / work_email) OR linkedin_url. If found, append the
 *     role to their `roles` array (no duplicate row) → counted as MERGED.
 *   - Otherwise insert a fresh row with the correctly-typed columns
 *     (candidate → current_title / current_company / location_text + phone;
 *     client → title / company_name / location + work_email),
 *     roles=[type], status='new', owner_user_id = the auth'd user → CREATED.
 *
 * Body: { type: "candidate"|"client", rows: ImportRow[] }
 *   ImportRow = { first_name?, last_name?, full_name?, email?, work_email?,
 *                 personal_email?, phone?, linkedin_url?, title?, company?,
 *                 location?, notes? }
 *
 * Returns: {
 *   created: string[]          // ids of newly-inserted people
 *   merged:  string[]          // ids of people we appended a role to
 *   failed:  { index, error }[] // 0-based index into the submitted rows
 *   peopleIds: string[]        // every id we touched (created ∪ merged) —
 *                              // feed straight into /api/people/enrich
 * }
 *
 * Auth: Bearer Supabase JWT (logged-in recruiter) or service-role key.
 */

const MAX_ROWS = 1000;
const CHUNK = 25; // rows processed in parallel per wave
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirror of the Postgres is_consumer_email_domain() helper so a single
 *  `email` column lands in the right typed slot, exactly like add-person. */
const CONSUMER_EMAIL_DOMAINS =
  /^(gmail|yahoo|hotmail|outlook|icloud|me|mac|aol|msn|live|protonmail|proton|fastmail|comcast|verizon|sbcglobal|att|optonline|ymail|hush|gmx|zoho|tutanota|cox|charter|earthlink|bellsouth|hanmail|naver)\.[a-z.]+$/i;

function isConsumerDomain(addr: string): boolean {
  const at = addr.indexOf("@");
  if (at < 0) return false;
  return CONSUMER_EMAIL_DOMAINS.test(addr.slice(at + 1).toLowerCase());
}

type ImportRow = {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  work_email?: string;
  personal_email?: string;
  phone?: string;
  linkedin_url?: string;
  title?: string;
  company?: string;
  location?: string;
  notes?: string;
};

const clean = (v: unknown): string => (v == null ? "" : String(v).trim());
const lower = (v: unknown): string => clean(v).toLowerCase();

/** Split a "full name" into first / last when explicit columns are absent.
 *  Last token = last name; everything before it = first name. */
function splitName(full: string): { first: string; last: string } {
  const parts = full.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

async function processRow(
  supabase: SupabaseClient,
  row: ImportRow,
  role: "candidate" | "client",
  userId: string | null,
): Promise<{ id: string; merged: boolean }> {
  // ── Resolve name ────────────────────────────────────────────────
  let first = clean(row.first_name);
  let last = clean(row.last_name);
  if (!first && !last && clean(row.full_name)) {
    const s = splitName(clean(row.full_name));
    first = s.first;
    last = s.last;
  }
  if (!first && !last) throw new Error("missing name (need first_name/last_name or full_name)");

  // ── Resolve emails ──────────────────────────────────────────────
  const email = lower(row.email) || null;
  let personalEmail = lower(row.personal_email) || null;
  let workEmail = lower(row.work_email) || null;
  for (const [label, addr] of [
    ["email", email],
    ["personal_email", personalEmail],
    ["work_email", workEmail],
  ] as const) {
    if (addr && !EMAIL_RE.test(addr)) throw new Error(`invalid ${label} format`);
  }

  const linkedinUrl = clean(row.linkedin_url) || null;

  // ── Dedupe: any stored email OR linkedin_url ────────────────────
  let existing: { id: string; roles: string[] | null } | null = null;
  const emailKeys = [email, personalEmail, workEmail].filter(Boolean) as string[];
  for (const e of emailKeys) {
    const { data: rows } = await supabase
      .from("people")
      .select("id, roles")
      .or(`primary_email.ilike.${e},personal_email.ilike.${e},work_email.ilike.${e}`)
      .limit(1);
    if (rows?.[0]) {
      existing = rows[0] as { id: string; roles: string[] | null };
      break;
    }
  }
  if (!existing && linkedinUrl) {
    const { data: rows } = await supabase
      .from("people")
      .select("id, roles")
      .eq("linkedin_url", linkedinUrl)
      .limit(1);
    if (rows?.[0]) existing = rows[0] as { id: string; roles: string[] | null };
  }

  // ── MERGE: append role to the existing person ───────────────────
  if (existing) {
    const currentRoles: string[] =
      Array.isArray(existing.roles) && existing.roles.length ? existing.roles : [role];
    const mergedRoles = currentRoles.includes(role) ? currentRoles : [...currentRoles, role];
    const { error: upErr } = await supabase
      .from("people")
      .update({ roles: mergedRoles, updated_at: new Date().toISOString() } as any)
      .eq("id", existing.id);
    if (upErr) throw upErr;
    return { id: existing.id, merged: true };
  }

  // ── INSERT: a brand-new person ──────────────────────────────────
  // Resolve a bare `email` into the right typed column (consumer → personal).
  if (email && !personalEmail && !workEmail) {
    if (isConsumerDomain(email)) personalEmail = email;
    else workEmail = email;
  }

  const fullName = `${first} ${last}`.trim();
  const payload: Record<string, any> = {
    first_name: first || null,
    last_name: last || null,
    full_name: fullName,
    personal_email: personalEmail,
    work_email: workEmail,
    phone: clean(row.phone) || null,
    linkedin_url: linkedinUrl,
    roles: [role],
    status: "new",
    owner_user_id: userId,
    created_by_user_id: userId,
    // Queue Unipile v2 resolve via the cron task when a LinkedIn URL exists.
    unipile_resolve_status: linkedinUrl ? "pending" : null,
  };
  if (role === "candidate") {
    payload.current_title = clean(row.title) || null;
    payload.current_company = clean(row.company) || null;
    payload.location_text = clean(row.location) || null;
    if (clean(row.notes)) payload.back_of_resume_notes = clean(row.notes);
  } else {
    payload.title = clean(row.title) || null;
    payload.company_name = clean(row.company) || null;
    payload.location_text = clean(row.location) || null;
    if (clean(row.notes)) payload.notes = clean(row.notes);
  }

  const { data: inserted, error } = await supabase
    .from("people")
    .insert(payload)
    .select("id")
    .single();
  if (error) throw error;
  return { id: inserted.id, merged: false };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const auth = await requireAuth(req, res);
  if (!auth) return; // response already sent
  const userId = auth.userId;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).json({ error: "Server misconfigured" });

  const rawType = req.body?.type;
  const role: "candidate" | "client" = rawType === "candidate" ? "candidate" : "client";
  const rows: ImportRow[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length === 0) return res.status(400).json({ error: "rows[] required" });
  if (rows.length > MAX_ROWS) return res.status(400).json({ error: `Max ${MAX_ROWS} rows per request` });

  const supabase = createClient(supabaseUrl, serviceKey);

  const created: string[] = [];
  const merged: string[] = [];
  const failed: { index: number; error: string }[] = [];

  // Process in fixed-size waves so dedupe lookups + inserts run with some
  // parallelism without overwhelming the connection pool. Index is preserved
  // so `failed[].index` maps back to the caller's row array.
  for (let start = 0; start < rows.length; start += CHUNK) {
    const slice = rows.slice(start, start + CHUNK);
    const results = await Promise.allSettled(
      slice.map((row) => processRow(supabase, row, role, userId)),
    );
    results.forEach((r, i) => {
      const index = start + i;
      if (r.status === "fulfilled") {
        if (r.value.merged) merged.push(r.value.id);
        else created.push(r.value.id);
      } else {
        const reason: any = r.reason;
        failed.push({ index, error: reason?.message || String(reason) || "unknown error" });
      }
    });
  }

  const peopleIds = [...created, ...merged];
  return res.status(200).json({ created, merged, failed, peopleIds });
}
