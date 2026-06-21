import { createClient } from "@supabase/supabase-js";
import { inngest } from "../client.js";
import { notifyError } from "../../../../src/server-lib/alerting.js";

/**
 * Daily LinkedIn sync-health check.
 *
 * LinkedIn seats silently lose their Unipile session — or a Recruiter seat
 * drops to "classic" capability — and inbound stops landing for days before
 * anyone notices (we saw two full weeks of zero LinkedIn messages, and the
 * Recruiter InMail count cratering). This cron flags the conditions and emails
 * the admins (throttled via notifyError):
 *
 *   1. Recruiter capability regression — an account_type='linkedin_recruiter'
 *      seat whose capabilities no longer include a recruiter/inmail scope, so
 *      InMail won't sync or send. Fix: reconnect / re-verify in
 *      Admin → Integrations.
 *   2. Missing Unipile v2 id — sends fall back to v1 and may fail.
 *   3. Sync stall — an active seat with no inbound LinkedIn message in >48h.
 */
export const linkedinSyncHealth = inngest.createFunction(
  { id: "linkedin-sync-health", name: "LinkedIn sync health check (Inngest)" },
  { cron: "0 14 * * *" }, // daily ~9am ET
  async ({ logger }) => {
    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    const { data: seats } = await supabase
      .from("integration_accounts")
      .select("id, account_label, account_type, linkedin_capabilities, unipile_account_id_v2")
      .eq("provider", "linkedin")
      .eq("is_active", true);

    if (!seats?.length) {
      logger.info("No active LinkedIn seats — skipping sync-health check");
      return { checked: 0, issues: 0 };
    }

    const STALL_HOURS = 48;
    const issues: string[] = [];

    for (const s of seats as any[]) {
      const label = s.account_label || s.id;
      const caps: string[] = Array.isArray(s.linkedin_capabilities) ? s.linkedin_capabilities : [];

      // 1. Recruiter capability regression.
      if (s.account_type === "linkedin_recruiter") {
        const hasRecruiter = caps.some((c) => {
          const v = String(c).toLowerCase();
          return v.includes("recruiter") || v.includes("inmail");
        });
        if (!hasRecruiter) {
          issues.push(
            `${label}: Recruiter seat is missing Recruiter capability (capabilities: ${caps.join(", ") || "none"}). ` +
            `InMail won't sync or send — reconnect / re-verify in Admin → Integrations.`,
          );
        }
      }

      // 2. Missing Unipile v2 id — sends can't take the v2 path.
      if (!s.unipile_account_id_v2) {
        issues.push(`${label}: no Unipile v2 account id — LinkedIn sends fall back to v1 and may fail. Reconnect to refresh.`);
      }

      // 3. Sync stall — last inbound LinkedIn message for this seat.
      const { data: last } = await supabase
        .from("messages")
        .select("created_at")
        .eq("integration_account_id", s.id)
        .in("channel", ["linkedin", "linkedin_recruiter"])
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const lastAt = last?.created_at ? new Date(last.created_at).getTime() : null;
      const hours = lastAt ? (Date.now() - lastAt) / 3_600_000 : Infinity;
      if (hours > STALL_HOURS) {
        issues.push(
          `${label}: no inbound LinkedIn message in ${lastAt ? `${Math.round(hours)}h` : "the last 30 days"} ` +
          `— sync may be stalled (Unipile session expired). Reconnect in Admin → Integrations.`,
        );
      }
    }

    if (issues.length) {
      await notifyError({
        taskId: "linkedin-sync-health",
        error: `LinkedIn sync health: ${issues.length} issue(s) detected:\n- ${issues.join("\n- ")}`,
        severity: "WARN",
        context: { issues },
      });
    }

    logger.info("LinkedIn sync-health check complete", { checked: seats.length, issues: issues.length });
    return { checked: seats.length, issues: issues.length };
  },
);
