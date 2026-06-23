/**
 * Inbound email bounce / NDR (non-delivery report) handling.
 *
 * When a send fails, the mailbox receives an "Undeliverable" report from
 * postmaster / MAILER-DAEMON / Microsoft Outlook. We detect those, pull out
 * the address that actually failed, mark that person's email invalid, and stop
 * any active sequence to them so we don't keep emailing a dead address.
 *
 * This logic originated inline in the process-unipile-event webhook, but inbound
 * email is actually ingested by the backfill-emails cron (the email webhook
 * isn't the live path), so the detection + handling is centralised here and
 * called from the backfill. See backfill-emails.ts.
 */
import { matchPersonByEmail } from "./match-person-by-email.js";
import { stopEnrollment } from "./sequence-runner.js";

export const EMAIL_BOUNCE_SENDER_RE = /^(postmaster|mailer-daemon|mail.daemon)@/i;
export const EMAIL_BOUNCE_SUBJECT_RE =
  /undeliverable|delivery (status|has|failure)|delivery has failed|returned mail|mail delivery (subsystem|failed)/i;

/** True if an inbound email looks like a bounce / NDR (by sender or subject). */
export function isBounceEmail(senderEmail: string | null | undefined, subject: string | null | undefined): boolean {
  return (
    EMAIL_BOUNCE_SENDER_RE.test(senderEmail || "") ||
    EMAIL_BOUNCE_SUBJECT_RE.test(subject || "")
  );
}

/**
 * Pull the address that failed out of a bounce body. Prefers the RFC-3464
 * `Final-Recipient` header, then an address adjacent to a failure phrase, then
 * the first address in the body that isn't itself a daemon/no-reply sender.
 */
export function extractFailedRecipient(body: string): string | null {
  const final = body.match(/Final-Recipient[^\n]*?(?:rfc822;\s*)?([\w.+-]+@[\w.-]+)/i);
  if (final?.[1]) return final[1].toLowerCase();
  const plain = body.match(
    /<([\w.+-]+@[\w.-]+)>[^\n]{0,200}?(?:not be delivered|undeliverable|address not found|user (?:unknown|not found)|550 5\.\d)/i,
  );
  if (plain?.[1]) return plain[1].toLowerCase();
  const all = Array.from(body.matchAll(/([\w.+-]+@[\w.-]+)/g)).map((m) => m[1].toLowerCase());
  const candidate = all.find((e) => !/^(postmaster|mailer-daemon|noreply|no-reply)@/i.test(e));
  return candidate ?? null;
}

/**
 * Mark the bounced person's email invalid and stop their active sequences.
 * Mirrors the process-unipile-event webhook: candidates flag on `people`,
 * contacts on `contacts`. Returns the matched entity, or null if the failed
 * address isn't a known person.
 */
export async function applyEmailBounce(
  supabase: any,
  failedEmail: string,
  reason: string,
  logger?: { info?: (msg: string, meta?: any) => void },
): Promise<{ entityType: string; entityId: string } | null> {
  const bouncedMatch = await matchPersonByEmail(supabase, failedEmail);
  if (!bouncedMatch) return null;

  const now = new Date().toISOString();
  const flags = { email_invalid: true, email_invalid_reason: reason, email_invalid_at: now };

  if (bouncedMatch.entityType === "contact") {
    await supabase.from("contacts").update(flags as any).eq("id", bouncedMatch.entityId);
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq("contact_id", bouncedMatch.entityId)
      .eq("status", "active");
    for (const e of enrollments ?? []) await stopEnrollment(supabase, e, "email_bounced", reason);
  } else {
    await supabase.from("people").update(flags as any).eq("id", bouncedMatch.entityId);
    const { data: enrollments } = await supabase
      .from("sequence_enrollments")
      .select("*, sequences!inner(*)")
      .eq("candidate_id", bouncedMatch.entityId)
      .eq("status", "active");
    for (const e of enrollments ?? []) await stopEnrollment(supabase, e, "email_bounced", reason);
  }

  logger?.info?.("Email bounce handled", {
    failedEmail,
    entityType: bouncedMatch.entityType,
    entityId: bouncedMatch.entityId,
  });
  return { entityType: bouncedMatch.entityType, entityId: bouncedMatch.entityId };
}
