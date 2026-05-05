/**
 * Centralised error alerting for Trigger.dev tasks.
 *
 * Reads two app_settings:
 *   - ALERT_RECIPIENTS  — comma-separated list of admin emails
 *   - ALERT_SENDER      — Microsoft Graph user to send from
 *
 * If either is missing, alerts are skipped (we still log the warning so
 * Trigger.dev's run log is the fallback record). Throttles per
 * (taskId, errorSignature) so a single bad inbound message doesn't
 * spam the inbox 100 times — same key only sends once per ALERT_TTL_MS.
 *
 * Designed to be called from inside silent-catch blocks where the task
 * has been swallowing failures with logger.warn → null. Use:
 *
 *   try { ... } catch (err) {
 *     await notifyError({ taskId: "intel-extraction", error: err, context: {...} });
 *     return null;
 *   }
 */

import { logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./supabase";
import { sendInternalEmail } from "./microsoft-graph";

const ALERT_TTL_MS = 60 * 60 * 1000; // 1 hour per (task, signature)

interface AlertCacheEntry {
  signature: string;
  lastSentAt: number;
}
const sentCache = new Map<string, AlertCacheEntry>();

interface NotifyErrorArgs {
  /** Stable identifier — usually the trigger task id. */
  taskId: string;
  /** The thrown value. */
  error: unknown;
  /** Free-form context about what was being processed when it failed. */
  context?: Record<string, any>;
  /** Override severity in the subject. Defaults to "ERROR". */
  severity?: "ERROR" | "WARN" | "INFO";
}

function errorSignature(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "unknown");
  // Strip volatile bits so the same error doesn't dedupe to different keys.
  return msg
    .replace(/[a-f0-9]{8,}/gi, "*")
    .replace(/\d{6,}/g, "*")
    .slice(0, 200);
}

async function readSettings(): Promise<{ sender: string; recipients: string[] }> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", ["ALERT_SENDER", "ALERT_RECIPIENTS"]);

  const byKey: Record<string, string> = {};
  for (const r of data ?? []) byKey[r.key] = r.value || "";

  const sender = byKey.ALERT_SENDER || "";
  const recipients = (byKey.ALERT_RECIPIENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return { sender, recipients };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Fire-and-forget — never throws. The error already happened upstream;
 * the alert path failing further would just hide it.
 */
export async function notifyError(args: NotifyErrorArgs): Promise<void> {
  const { taskId, error, context, severity = "ERROR" } = args;
  const sig = errorSignature(error);
  const cacheKey = `${taskId}:${sig}`;
  const now = Date.now();
  const cached = sentCache.get(cacheKey);
  if (cached && now - cached.lastSentAt < ALERT_TTL_MS) {
    return; // throttle
  }

  // Always log first — that's the source-of-truth even if email fails.
  const errMsg = error instanceof Error ? error.message : String(error ?? "");
  const errStack = error instanceof Error ? error.stack : undefined;
  logger.error(`[${taskId}] ${errMsg}`, { context, stack: errStack?.slice(0, 1000) });

  let sender = "";
  let recipients: string[] = [];
  try {
    ({ sender, recipients } = await readSettings());
  } catch {
    return; // settings unreachable; log already happened
  }
  if (!sender || recipients.length === 0) return;

  const subject = `[${severity}] ${taskId} — ${sig.slice(0, 80)}`;
  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px">
      <h2 style="margin:0 0 4px 0;color:#dc2626">${severity}: ${escapeHtml(taskId)}</h2>
      <p style="color:#666;margin:0 0 12px 0">Trigger.dev task failure</p>
      <pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:12px">${escapeHtml(errMsg)}</pre>
      ${context ? `<h3 style="margin:16px 0 4px 0">Context</h3><pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;font-size:12px">${escapeHtml(JSON.stringify(context, null, 2))}</pre>` : ""}
      ${errStack ? `<h3 style="margin:16px 0 4px 0">Stack (truncated)</h3><pre style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:12px;font-size:11px;color:#666">${escapeHtml(errStack.slice(0, 2000))}</pre>` : ""}
      <p style="color:#999;font-size:11px;margin-top:16px">Throttled: same task+signature won't re-alert for 1 hour.</p>
    </div>`;

  try {
    await sendInternalEmail(sender, recipients, subject, html);
    sentCache.set(cacheKey, { signature: sig, lastSentAt: now });
  } catch (mailErr: any) {
    logger.warn(`[${taskId}] alert email failed`, { error: mailErr?.message });
  }
}
