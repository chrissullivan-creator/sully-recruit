import { schedules, task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting } from "./lib/supabase";
import { delay } from "./lib/resume-parsing";
import { classifyEmail, normalizeEmail } from "../lib/email-classifier";

// ─── Clay API helper ────────────────────────────────────────────────────────

async function pushRowsToClay(
  apiKey: string,
  webhookUrl: string,
  rows: Record<string, any>[],
): Promise<void> {
  if (rows.length === 0) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Include API key as Bearer token if available (recommended by Clay)
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clay webhook ${res.status}: ${text}`);
  }
}

// ─── Field extraction helpers ───────────────────────────────────────────────

function extractField(row: Record<string, any>, ...keys: string[]): string | null {
  for (const key of keys) {
    const val = row[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

function buildCandidateUpdate(row: Record<string, any>, existing: Record<string, any>) {
  const updates: Record<string, any> = {};

  if (!existing.email) {
    const email = extractField(row, "personal_email", "email", "work_email");
    if (email) updates.email = email;
  }
  if (!existing.phone) {
    const phone = extractField(row, "mobile_phone", "phone", "personal_phone");
    if (phone) updates.phone = phone;
  }
  if (!existing.linkedin_url) {
    const url = extractField(row, "linkedin_url", "linkedin_profile_url", "linkedinUrl");
    if (url) updates.linkedin_url = url;
  }
  if (!existing.current_title) {
    const title = extractField(row, "title", "job_title", "current_title");
    if (title) updates.current_title = title;
  }
  if (!existing.current_company) {
    const company = extractField(row, "company", "company_name", "current_company");
    if (company) updates.current_company = company;
  }
  if (!existing.location_text) {
    const loc = extractField(row, "location", "city", "location_text");
    if (loc) updates.location_text = loc;
  }

  return updates;
}

function buildContactUpdate(row: Record<string, any>, existing: Record<string, any>) {
  const updates: Record<string, any> = {};

  if (!existing.email) {
    const email = extractField(row, "work_email", "email", "personal_email");
    if (email) updates.email = email;
  }
  if (!existing.phone) {
    const phone = extractField(row, "phone", "work_phone", "mobile_phone");
    if (phone) updates.phone = phone;
  }
  if (!existing.linkedin_url) {
    const url = extractField(row, "linkedin_url", "linkedin_profile_url", "linkedinUrl");
    if (url) updates.linkedin_url = url;
  }
  if (!existing.title) {
    const title = extractField(row, "title", "job_title");
    if (title) updates.title = title;
  }
  if (!existing.department) {
    const dept = extractField(row, "department");
    if (dept) updates.department = dept;
  }

  return updates;
}

// ─── Task A: Push records to Clay (scheduled) ──────────────────────────────

export const pushToClay = schedules.task({
  id: "push-to-clay",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Check toggle — if disabled, skip entirely
    let enabled: string;
    try {
      enabled = await getAppSetting("CLAY_ENRICHMENT_ENABLED");
    } catch {
      logger.info("CLAY_ENRICHMENT_ENABLED not set, skipping");
      return { skipped: true, reason: "toggle_off" };
    }
    if (enabled !== "true") {
      logger.info("Clay enrichment disabled");
      return { skipped: true, reason: "toggle_off" };
    }

    let apiKey = "";
    try {
      apiKey = await getAppSetting("CLAY_API_KEY");
    } catch {
      // API key is optional for webhook URLs (URL itself is the auth)
    }
    let candidateWebhookUrl: string;
    let contactWebhookUrl: string;
    try {
      candidateWebhookUrl = await getAppSetting("CLAY_WEBHOOK_URL_CANDIDATES");
    } catch {
      candidateWebhookUrl = "";
    }
    try {
      contactWebhookUrl = await getAppSetting("CLAY_WEBHOOK_URL_CONTACTS");
    } catch {
      contactWebhookUrl = "";
    }

    let candidatesPushed = 0;
    let contactsPushed = 0;

    // ── Candidates (personal info) ────────────────────────────────────
    if (candidateWebhookUrl) {
      // Case 1: Has linkedin_url, missing email or phone — Unipile already tried
      const { data: cands1 } = await supabase
        .from("candidates")
        .select("id, first_name, last_name, full_name, email, phone, linkedin_url")
        .not("linkedin_url", "is", null)
        .is("clay_enriched_at", null)
        .not("linkedin_enriched_at", "is", null)
        .or("email.is.null,phone.is.null")
        .order("created_at", { ascending: false })
        .limit(15);

      // Case 2: Has email + phone, no linkedin_url — need LinkedIn URL for Unipile
      const { data: cands2 } = await supabase
        .from("candidates")
        .select("id, first_name, last_name, full_name, email, phone, linkedin_url")
        .is("linkedin_url", null)
        .is("clay_enriched_at", null)
        .not("email", "is", null)
        .not("phone", "is", null)
        .order("created_at", { ascending: false })
        .limit(5);

      const allCandidates = [...(cands1 ?? []), ...(cands2 ?? [])];
      if (allCandidates.length > 0) {
        const rows = allCandidates.map((c: any) => ({
          sully_id: `candidate::${c.id}`,
          first_name: c.first_name ?? "",
          last_name: c.last_name ?? "",
          full_name: c.full_name ?? "",
          email: c.email ?? "",
          phone: c.phone ?? "",
          linkedin_url: c.linkedin_url ?? "",
        }));

        try {
          await pushRowsToClay(apiKey, candidateWebhookUrl, rows);
          candidatesPushed = rows.length;

          // Mark as sent
          const ids = allCandidates.map((c: any) => c.id);
          await supabase
            .from("candidates")
            .update({ clay_enriched_at: new Date().toISOString() })
            .in("id", ids);
        } catch (err: any) {
          logger.error("Failed to push candidates to Clay", { error: err.message });
        }
      }
    }

    // ── Contacts (business info) ──────────────────────────────────────
    if (contactWebhookUrl) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, full_name, email, phone, linkedin_url, title, company_id, companies(domain)")
        .is("email", null)
        .is("clay_enriched_at", null)
        .or("linkedin_enriched_at.not.is.null,linkedin_url.is.null")
        .order("created_at", { ascending: false })
        .limit(20);

      const contactList = contacts ?? [];
      if (contactList.length > 0) {
        const rows = contactList.map((c: any) => ({
          sully_id: `contact::${c.id}`,
          first_name: c.first_name ?? "",
          last_name: c.last_name ?? "",
          full_name: c.full_name ?? "",
          email: c.email ?? "",
          phone: c.phone ?? "",
          linkedin_url: c.linkedin_url ?? "",
          title: c.title ?? "",
          company_domain: c.companies?.domain ?? "",
        }));

        try {
          await pushRowsToClay(apiKey, contactWebhookUrl, rows);
          contactsPushed = rows.length;

          const ids = contactList.map((c: any) => c.id);
          await supabase
            .from("contacts")
            .update({ clay_enriched_at: new Date().toISOString() })
            .in("id", ids);
        } catch (err: any) {
          logger.error("Failed to push contacts to Clay", { error: err.message });
        }
      }
    }

    logger.info("Push to Clay complete", { candidatesPushed, contactsPushed });
    return { candidatesPushed, contactsPushed };
  },
});

// ─── Task B: Pull enriched data FROM Clay tables ──────────────────────────

async function fetchClayRows(
  apiKey: string,
  tableId: string,
): Promise<Record<string, any>[]> {
  const res = await fetch(`https://api.clay.com/v3/tables/${tableId}/rows`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Clay API ${res.status}: ${text}`);
  }

  const data = await res.json();
  // Clay returns { rows: [...] } or an array directly
  return Array.isArray(data) ? data : data?.rows ?? data?.data ?? [];
}

export const pullFromClay = schedules.task({
  id: "pull-from-clay",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    let enabled: string;
    try {
      enabled = await getAppSetting("CLAY_ENRICHMENT_ENABLED");
    } catch {
      logger.info("CLAY_ENRICHMENT_ENABLED not set, skipping pull");
      return { skipped: true, reason: "toggle_off" };
    }
    if (enabled !== "true") {
      logger.info("Clay enrichment disabled");
      return { skipped: true, reason: "toggle_off" };
    }

    const apiKey = await getAppSetting("CLAY_API_KEY");
    if (!apiKey) {
      logger.error("CLAY_API_KEY not set");
      return { skipped: true, reason: "no_api_key" };
    }

    let candidateTableId = "";
    let contactTableId = "";
    try { candidateTableId = await getAppSetting("CLAY_TABLE_ID_CANDIDATES"); } catch {}
    try { contactTableId = await getAppSetting("CLAY_TABLE_ID_CONTACTS"); } catch {}

    let candidatesUpdated = 0;
    let contactsUpdated = 0;
    let skipped = 0;

    // ── Pull candidates ───────────────────────────────────────────────
    if (candidateTableId) {
      try {
        const rows = await fetchClayRows(apiKey, candidateTableId);
        logger.info("Fetched candidate rows from Clay", { count: rows.length });

        for (const row of rows) {
          const sullyId = row.sully_id || row.sullyId || row.sully_record_id;
          if (!sullyId || typeof sullyId !== "string" || !sullyId.startsWith("candidate::")) {
            skipped++;
            continue;
          }
          const entityId = sullyId.split("::")[1];

          const { data: existing } = await supabase
            .from("candidates")
            .select("first_name, last_name, email, phone, linkedin_url, current_title, current_company, location_text")
            .eq("id", entityId)
            .single();

          if (!existing) { skipped++; continue; }

          const updates: Record<string, string> = {};

          // Clay enriched columns — "Email Address" and "Phone Number" are the final outputs
          if (!existing.email) {
            const v = normalizeEmail(extractField(row, "Email Address", "email", "Personal Email", "personal_email", "work_email"));
            if (v) {
              updates.email = v;
              Object.assign(updates, classifyEmail(v));
            }
          }
          if (!existing.phone) {
            const v = extractField(row, "Phone Number", "phone_number", "Mobile Phone", "mobile_phone", "phone");
            if (v) updates.phone = v;
          }
          if (!existing.linkedin_url) {
            const v = extractField(row, "linkedin_url", "LinkedIn URL", "linkedin_profile_url");
            if (v) updates.linkedin_url = v;
          }
          if (!existing.current_title) {
            const v = extractField(row, "title", "Title", "job_title");
            if (v) updates.current_title = v;
          }
          if (!existing.current_company) {
            const v = extractField(row, "company", "Company", "company_name");
            if (v) updates.current_company = v;
          }
          if (!existing.first_name) {
            const v = extractField(row, "first_name", "First Name");
            if (v) updates.first_name = v;
          }
          if (!existing.last_name) {
            const v = extractField(row, "last_name", "Last Name");
            if (v) updates.last_name = v;
          }
          if (!existing.location_text) {
            const v = extractField(row, "location", "Location", "city");
            if (v) updates.location_text = v;
          }

          if (Object.keys(updates).length > 0) {
            await supabase.from("candidates").update(updates).eq("id", entityId);
            logger.info("Pulled candidate update from Clay", { entityId, fields: Object.keys(updates) });
            candidatesUpdated++;
          } else {
            skipped++;
          }
        }
      } catch (err: any) {
        logger.error("Failed to pull candidates from Clay", { error: err.message });
      }
    }

    // ── Pull contacts ─────────────────────────────────────────────────
    if (contactTableId) {
      try {
        const rows = await fetchClayRows(apiKey, contactTableId);
        logger.info("Fetched contact rows from Clay", { count: rows.length });

        for (const row of rows) {
          const sullyId = row.sully_id || row.sullyId || row.sully_record_id;
          if (!sullyId || typeof sullyId !== "string" || !sullyId.startsWith("contact::")) {
            skipped++;
            continue;
          }
          const entityId = sullyId.split("::")[1];

          const { data: existing } = await supabase
            .from("contacts")
            .select("first_name, last_name, email, phone, linkedin_url, title, department")
            .eq("id", entityId)
            .single();

          if (!existing) { skipped++; continue; }

          const updates: Record<string, string> = {};

          if (!existing.email) {
            const v = normalizeEmail(extractField(row, "Work Email", "work_email", "Email Address", "email", "Personal Email"));
            if (v) {
              updates.email = v;
              Object.assign(updates, classifyEmail(v));
            }
          }
          if (!existing.phone) {
            const v = extractField(row, "Phone Number", "phone_number", "Mobile Phone", "phone");
            if (v) updates.phone = v;
          }
          if (!existing.linkedin_url) {
            const v = extractField(row, "linkedin_url", "LinkedIn URL", "linkedin_profile_url");
            if (v) updates.linkedin_url = v;
          }
          if (!existing.title) {
            const v = extractField(row, "title", "Title", "job_title");
            if (v) updates.title = v;
          }
          if (!existing.first_name) {
            const v = extractField(row, "first_name", "First Name");
            if (v) updates.first_name = v;
          }
          if (!existing.last_name) {
            const v = extractField(row, "last_name", "Last Name");
            if (v) updates.last_name = v;
          }
          if (!existing.department) {
            const v = extractField(row, "department", "Department");
            if (v) updates.department = v;
          }

          if (Object.keys(updates).length > 0) {
            await supabase.from("contacts").update(updates).eq("id", entityId);
            logger.info("Pulled contact update from Clay", { entityId, fields: Object.keys(updates) });
            contactsUpdated++;
          } else {
            skipped++;
          }
        }
      } catch (err: any) {
        logger.error("Failed to pull contacts from Clay", { error: err.message });
      }
    }

    logger.info("Pull from Clay complete", { candidatesUpdated, contactsUpdated, skipped });
    return { candidatesUpdated, contactsUpdated, skipped };
  },
});
