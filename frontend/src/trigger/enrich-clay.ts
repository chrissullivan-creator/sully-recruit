import { schedules, task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting } from "./lib/supabase";
import { delay } from "./lib/resume-parsing";

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

// ─── Task B: Process Clay webhook (enrichment results) ─────────────────────

interface ClayWebhookPayload {
  body: any;
  receivedAt: string;
}

export const processClayEnrichment = task({
  id: "process-clay-enrichment",
  retry: { maxAttempts: 3 },
  run: async (payload: ClayWebhookPayload) => {
    const supabase = getSupabaseAdmin();
    const body = payload.body;

    // Clay may send a single row or an array of rows
    const rows: Record<string, any>[] = Array.isArray(body) ? body : body?.rows ?? body?.data ?? [body];

    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        const sullyId = row.sully_id || row.sullyId || row.sully_record_id;
        if (!sullyId || typeof sullyId !== "string") {
          logger.warn("Clay row missing sully_id", { row: JSON.stringify(row).slice(0, 200) });
          skipped++;
          continue;
        }

        const [entityType, entityId] = sullyId.split("::");
        if (!entityType || !entityId) {
          logger.warn("Invalid sully_id format", { sullyId });
          skipped++;
          continue;
        }

        if (entityType === "candidate") {
          // Fetch current record to check which fields are null
          const { data: existing } = await supabase
            .from("candidates")
            .select("email, phone, linkedin_url, current_title, current_company, location_text")
            .eq("id", entityId)
            .single();

          if (!existing) {
            logger.warn("Candidate not found", { entityId });
            skipped++;
            continue;
          }

          const updates = buildCandidateUpdate(row, existing);
          if (Object.keys(updates).length > 0) {
            await supabase.from("candidates").update(updates).eq("id", entityId);
            logger.info("Updated candidate from Clay", { entityId, fields: Object.keys(updates) });
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
            logger.warn("Contact not found", { entityId });
            skipped++;
            continue;
          }

          const updates = buildContactUpdate(row, existing);
          if (Object.keys(updates).length > 0) {
            await supabase.from("contacts").update(updates).eq("id", entityId);
            logger.info("Updated contact from Clay", { entityId, fields: Object.keys(updates) });
            updated++;
          } else {
            skipped++;
          }
        } else {
          logger.warn("Unknown entity type in sully_id", { sullyId });
          skipped++;
        }
      } catch (err: any) {
        failed++;
        logger.error("Clay row processing error", { error: err.message });
      }
    }

    logger.info("Clay enrichment processing complete", { updated, skipped, failed });
    return { updated, skipped, failed };
  },
});
