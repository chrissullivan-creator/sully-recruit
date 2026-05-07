import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";
import {
  getMicrosoftAccessToken,
  createOrUpdateOutlookContact,
} from "./lib/microsoft-graph";

/**
 * Push every Sully candidate/contact into the owner's Outlook Contacts.
 *
 * One-way for now (Sully → Outlook). Idempotent on
 * `people.outlook_contact_id`: NULL = create, non-null = patch. Runs
 * twice an hour to keep mailboxes fresh without hammering Graph.
 *
 * Owner resolution: `people.owner_user_id` → `profiles.email`. We only
 * sync rows that have BOTH an owner email *and* a person email — Outlook
 * contacts without an email are mostly useless (no auto-suggest, no
 * dedup), so we skip them. Owners without a profile email are skipped
 * silently.
 */
export const syncPeopleToOutlook = schedules.task({
  id: "sync-people-to-outlook",
  cron: "*/30 * * * *",
  run: async () => {
    const supabase = getSupabaseAdmin();

    // Pick a batch — newly added or recently updated, owned + has email,
    // not yet synced or stale (>24h since last sync).
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // primary_email is the new generated column = COALESCE(work_email, personal_email).
    // The plain `people.email` column was retired in 20260507140000.
    const { data: rows, error } = await supabase
      .from("people")
      .select(`
        id, type, first_name, last_name, full_name, primary_email, phone,
        current_title, current_company, linkedin_url,
        owner_user_id, outlook_contact_id, outlook_contact_synced_at
      `)
      .not("owner_user_id", "is", null)
      .not("primary_email", "is", null)
      .or(`outlook_contact_id.is.null,outlook_contact_synced_at.lt.${stale}`)
      .limit(50);

    if (error) {
      logger.error("Outlook sync query failed", { error: error.message });
      return { action: "error" };
    }
    if (!rows || rows.length === 0) return { action: "idle" };

    // Resolve owner emails in one trip (a person can be owned by any of
    // 3-ish recruiters, so this is tiny).
    const ownerIds = Array.from(new Set(rows.map((r: any) => r.owner_user_id).filter(Boolean)));
    const { data: profiles } = await supabase
      .from("profiles")
      .select("id, email")
      .in("id", ownerIds);
    const ownerEmail = new Map<string, string>();
    for (const p of (profiles ?? []) as any[]) {
      if (p.email) ownerEmail.set(p.id, p.email);
    }

    const accessToken = await getMicrosoftAccessToken();
    let synced = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of rows as any[]) {
      const ownerAddr = ownerEmail.get(r.owner_user_id);
      if (!ownerAddr) { skipped++; continue; }

      try {
        const contactId = await createOrUpdateOutlookContact(
          accessToken,
          ownerAddr,
          {
            first_name: r.first_name,
            last_name: r.last_name,
            full_name: r.full_name,
            email: r.primary_email,
            phone: r.phone,
            current_title: r.current_title,
            current_company: r.current_company,
            linkedin_url: r.linkedin_url,
          },
          r.outlook_contact_id,
        );
        await supabase
          .from("people")
          .update({
            outlook_contact_id: contactId,
            outlook_contact_synced_at: new Date().toISOString(),
          } as any)
          .eq("id", r.id);
        synced++;
      } catch (err: any) {
        logger.warn("Outlook contact sync failed for person", {
          personId: r.id, owner: ownerAddr, error: err.message,
        });
        failed++;
      }
    }

    return { action: "synced", synced, skipped, failed, found: rows.length };
  },
});
