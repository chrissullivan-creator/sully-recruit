import { schedules, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin, getAppSetting } from "./lib/supabase";
import { sendInternalEmail } from "./lib/microsoft-graph";

/**
 * Daily pipeline-health digest. Counts what's stuck across resume parsing,
 * call transcripts, and sentiment so we don't go five weeks without
 * realising sentiment quietly stopped working again.
 *
 * Recipients/sender share the same app_settings as the alerting helper:
 *   ALERT_SENDER, ALERT_RECIPIENTS
 *
 * Runs once a day at 13:00 UTC (~9am ET).
 */
export const pipelineHealthDigest = schedules.task({
  id: "pipeline-health-digest",
  cron: "0 13 * * *",
  maxDuration: 120,
  run: async () => {
    const supabase = getSupabaseAdmin();

    let sender = "";
    let recipients: string[] = [];
    try { sender = (await getAppSetting("ALERT_SENDER")) || ""; } catch {}
    try {
      const raw = (await getAppSetting("ALERT_RECIPIENTS")) || "";
      recipients = raw.split(",").map((s) => s.trim()).filter(Boolean);
    } catch {}
    if (!sender || recipients.length === 0) {
      logger.info("Digest skipped — sender/recipients not configured");
      return { skipped: true };
    }

    // ── RESUMES ─────────────────────────────────────────────────────
    const { data: resumeStats } = await supabase
      .from("resumes")
      .select("parsing_status")
      .gt("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString());
    const rCounts = bucket(resumeStats?.map((r: any) => r.parsing_status) ?? []);

    const { count: resumeStuck } = await supabase
      .from("resumes")
      .select("id", { count: "exact", head: true })
      .is("candidate_id", null)
      .not("parsing_status", "in", '("failed","skipped","completed")')
      .lt("created_at", new Date(Date.now() - 6 * 3600_000).toISOString());

    // ── CALL TRANSCRIPTS ────────────────────────────────────────────
    const { count: callsEligible } = await supabase
      .from("call_logs")
      .select("id", { count: "exact", head: true })
      .gte("duration_seconds", 30)
      .eq("status", "completed")
      .gt("started_at", new Date(Date.now() - 7 * 86_400_000).toISOString());

    const { data: notedIds } = await supabase
      .from("ai_call_notes")
      .select("call_log_id")
      .gt("created_at", new Date(Date.now() - 7 * 86_400_000).toISOString());
    const notedCount = (notedIds ?? []).length;
    const callsMissingNote = Math.max(0, (callsEligible ?? 0) - notedCount);

    // ── SENTIMENT ──────────────────────────────────────────────────
    const { count: inbound24h } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("direction", "inbound")
      .gt("sent_at", new Date(Date.now() - 86_400_000).toISOString());

    const { count: sentiments24h } = await supabase
      .from("reply_sentiment")
      .select("id", { count: "exact", head: true })
      .gt("created_at", new Date(Date.now() - 86_400_000).toISOString());

    // ── BUILD EMAIL ─────────────────────────────────────────────────
    const sentimentRate =
      inbound24h && inbound24h > 0
        ? Math.round(((sentiments24h ?? 0) / inbound24h) * 100)
        : null;

    const flags: string[] = [];
    if ((resumeStuck ?? 0) > 0) flags.push(`${resumeStuck} resumes stuck >6h`);
    if (callsMissingNote > 5) flags.push(`${callsMissingNote} calls missing transcripts (7d)`);
    if (sentimentRate != null && sentimentRate < 30 && (inbound24h ?? 0) > 5)
      flags.push(`Sentiment running on only ${sentimentRate}% of inbound`);

    const headline = flags.length === 0
      ? `<span style="color:#16a34a">All systems normal</span>`
      : `<span style="color:#dc2626">${flags.length} issue${flags.length === 1 ? "" : "s"}</span> — ${flags.join(", ")}`;

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px">
        <h2 style="margin:0 0 4px 0">Sully Recruit — pipeline health</h2>
        <p style="color:#666;margin:0 0 16px 0">${headline}</p>

        <h3 style="margin:16px 0 4px 0">Resume parsing (last 30d)</h3>
        ${kvTable([
          ["Completed", String(rCounts.completed ?? 0)],
          ["Pending", String(rCounts.pending ?? 0)],
          ["Failed", String(rCounts.failed ?? 0)],
          ["Skipped", String(rCounts.skipped ?? 0)],
          ["Stuck >6h (no candidate)", String(resumeStuck ?? 0)],
        ])}

        <h3 style="margin:16px 0 4px 0">Call transcripts (last 7d)</h3>
        ${kvTable([
          ["Eligible calls (≥30s, completed)", String(callsEligible ?? 0)],
          ["Have transcript", String(notedCount)],
          ["Missing transcript", String(callsMissingNote)],
        ])}

        <h3 style="margin:16px 0 4px 0">Sentiment (last 24h)</h3>
        ${kvTable([
          ["Inbound messages", String(inbound24h ?? 0)],
          ["Sentiment rows written", String(sentiments24h ?? 0)],
          ["Hit rate", sentimentRate == null ? "n/a" : `${sentimentRate}%`],
        ])}
      </div>`;

    const subject = flags.length === 0
      ? "Sully Recruit — pipeline health: all good"
      : `Sully Recruit — pipeline health: ${flags.length} issue${flags.length === 1 ? "" : "s"}`;

    try {
      await sendInternalEmail(sender, recipients, subject, html);
      logger.info("Digest sent", { recipients, flags });
    } catch (e: any) {
      logger.warn("Digest email failed", { error: e.message });
    }

    return { flags, resumeStuck, callsMissingNote, inbound24h, sentiments24h };
  },
});

function bucket(values: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const v of values) m[v] = (m[v] ?? 0) + 1;
  return m;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function kvTable(rows: [string, string][]): string {
  return `<table style="border-collapse:collapse;font-size:14px">
    ${rows.map(([k, v]) => `<tr>
      <td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(k)}</td>
      <td style="padding:4px 0;font-weight:600">${escapeHtml(v)}</td>
    </tr>`).join("")}
  </table>`;
}
