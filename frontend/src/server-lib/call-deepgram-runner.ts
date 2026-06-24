import { getSupabaseAdmin, getAnthropicKey, getOpenAIKey, getAppSetting } from "./supabase.js";
import { callAIWithFallback } from "../lib/ai-fallback.js";
import { sendInternalEmail } from "./microsoft-graph.js";
import { notifyError } from "./alerting.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchRcCallLog } from "./rc-call-log.js";

const RC_SERVER = "https://platform.ringcentral.com";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Fire a post-call summary email to the team after Claude has finished
 * analyzing the transcript. Driven by two app_settings keys (with
 * ALERT_SENDER / ALERT_RECIPIENTS as fallbacks):
 *   CALL_REPORT_SENDER     — Microsoft Graph mailbox to send from
 *   CALL_REPORT_RECIPIENTS — comma-separated To: list
 * Never throws — alerting on a failed alert just hides the original.
 */
async function sendCallSummaryEmail(args: {
  entityName: string;
  entityType: string | null;
  entityId: string | null;
  ownerLabel: string;
  durationFormatted: string;
  direction: string;
  phoneNumber: string | null;
  startedAt: string | null;
  intel: any;
  callLogId: string;
  logger: any;
}): Promise<void> {
  try {
    let sender = "";
    let recipientsRaw = "";
    try { sender = (await getAppSetting("CALL_REPORT_SENDER")) || (await getAppSetting("ALERT_SENDER")) || ""; } catch { /* unset */ }
    try { recipientsRaw = (await getAppSetting("CALL_REPORT_RECIPIENTS")) || (await getAppSetting("ALERT_RECIPIENTS")) || ""; } catch { /* unset */ }
    const recipients = recipientsRaw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!sender || recipients.length === 0) {
      args.logger.info("Call summary email skipped — CALL_REPORT_SENDER/RECIPIENTS not set");
      return;
    }

    const intel = args.intel || {};
    const summary = typeof intel.summary === "string" ? intel.summary : "";
    const actionItems = typeof intel.action_items === "string" ? intel.action_items : "";

    const fmtUsd = (v: any): string | null => {
      const n = typeof v === "number" ? v : (typeof v === "string" ? parseInt(v.replace(/[^\d]/g, ""), 10) : NaN);
      return Number.isFinite(n) && n > 0 ? `$${n.toLocaleString("en-US")}` : null;
    };
    const compRows: Array<[string, string]> = [];
    const curBase = fmtUsd(intel.current_base);
    const curBonus = fmtUsd(intel.current_bonus);
    const tgtBase = fmtUsd(intel.target_base);
    const tgtBonus = fmtUsd(intel.target_bonus);
    if (curBase) compRows.push(["Current base", curBase]);
    if (curBonus) compRows.push(["Current bonus", curBonus]);
    if (tgtBase) compRows.push(["Target base", tgtBase]);
    if (tgtBonus) compRows.push(["Target bonus", tgtBonus]);

    const otherFields: Array<[string, string]> = [];
    const addIfStr = (label: string, v: any) => {
      if (typeof v === "string" && v.trim()) otherFields.push([label, v.trim()]);
    };
    addIfStr("Reason for leaving", intel.reason_for_leaving);
    addIfStr("Current title", intel.current_title);
    addIfStr("Current company", intel.current_company);
    addIfStr("Looking to do next", intel.looking_to_do_next);
    addIfStr("Notice period", intel.notice_period);
    addIfStr("Work authorization", intel.work_authorization);
    addIfStr("Relocation", intel.relocation_preference);

    const actionItemsHtml = actionItems
      ? actionItems
          .split("\n")
          .map((l) => l.replace(/^[-*]\s*/, "").trim())
          .filter(Boolean)
          .map((l) => `<li>${escapeHtml(l)}</li>`)
          .join("")
      : "";

    const candidateLink = args.entityType === "candidate" && args.entityId
      ? `<p style="margin:0 0 16px"><a href="https://app.sullyrecruit.com/candidates/${args.entityId}" style="color:#0ea5e9;text-decoration:none">Open ${escapeHtml(args.entityName)} →</a></p>`
      : "";

    const startedLine = args.startedAt
      ? new Date(args.startedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" })
      : "";

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:680px;color:#111">
        <p style="color:#666;margin:0 0 4px;font-size:13px">${escapeHtml(args.ownerLabel)} • ${escapeHtml(args.direction)} • ${escapeHtml(args.durationFormatted)}${startedLine ? ` • ${escapeHtml(startedLine)} ET` : ""}${args.phoneNumber ? ` • ${escapeHtml(args.phoneNumber)}` : ""}</p>
        <h2 style="margin:0 0 12px;font-size:20px">Call with ${escapeHtml(args.entityName)}</h2>
        ${candidateLink}
        ${summary ? `<h3 style="margin:0 0 6px;font-size:14px;color:#444">Summary</h3><p style="margin:0 0 16px;white-space:pre-wrap">${escapeHtml(summary)}</p>` : ""}
        ${actionItemsHtml ? `<h3 style="margin:0 0 6px;font-size:14px;color:#444">Action items</h3><ul style="margin:0 0 16px;padding-left:20px">${actionItemsHtml}</ul>` : ""}
        ${compRows.length ? `<h3 style="margin:0 0 6px;font-size:14px;color:#444">Comp intel</h3><table style="border-collapse:collapse;margin:0 0 16px;font-size:14px">${compRows.map(([k,v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(k)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(v)}</td></tr>`).join("")}</table>` : ""}
        ${otherFields.length ? `<h3 style="margin:0 0 6px;font-size:14px;color:#444">Notes</h3><table style="border-collapse:collapse;margin:0 0 16px;font-size:14px">${otherFields.map(([k,v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">${escapeHtml(k)}</td><td style="padding:4px 0">${escapeHtml(v)}</td></tr>`).join("")}</table>` : ""}
        <p style="color:#999;margin:24px 0 0;font-size:12px">Auto-sent by Sully Recruit after Joe finished analyzing the recording. call_log_id: ${escapeHtml(args.callLogId)}</p>
      </div>`;

    const subject = `📞 Call with ${args.entityName} — ${args.durationFormatted}`;
    await sendInternalEmail(sender, recipients, subject, html);
    args.logger.info("Call summary email sent", { recipients, callLogId: args.callLogId });
  } catch (err: any) {
    args.logger.warn("Call summary email failed", { error: err?.message });
  }
}

/**
 * Engine-neutral body for the call-deepgram pipeline:
 *   download recording from RingCentral → transcribe via Deepgram Nova-3 →
 *   extract intel with Joe (Claude Sonnet) → write ai_call_notes →
 *   update call_logs + people fields.
 *
 * Both the Trigger.dev `processCallDeepgram` task and the Inngest
 * `processCallDeepgram` function delegate here so behavior is identical
 * regardless of which orchestrator drives the call.
 *
 * Payload modes:
 *   - { call_log_id: "<uuid>" }     — process a specific call (webhook + cron use)
 *   - { batch: true, limit: 50 }    — process up to N un-noted calls (manual catchup)
 *   - { batch: true, dry_run: true} — preview without writing
 */
export interface CallDeepgramPayload {
  call_log_id?: string;
  batch?: boolean;
  limit?: number;
  dry_run?: boolean;
}

export async function runProcessCallDeepgram(payload: CallDeepgramPayload, logger: any) {
  const supabase = getSupabaseAdmin();
  const anthropicKey = await getAnthropicKey();
  const deepgramKey = await getAppSetting("DEEPGRAM_API_KEY");
  if (!deepgramKey) throw new Error("DEEPGRAM_API_KEY not found in app_settings");

  let toProcess: any[] = [];

  if (payload.call_log_id) {
    const { data } = await supabase
      .from("call_logs")
      .select("id, owner_id, external_call_id, phone_number, direction, duration_seconds, started_at, ended_at, linked_entity_type, linked_entity_id")
      .eq("id", payload.call_log_id)
      .single();
    if (data) toProcess = [data];
  } else if (payload.batch) {
    const limit = payload.limit ?? 50;
    const { data: eligible } = await supabase
      .from("call_logs")
      .select("id, owner_id, external_call_id, phone_number, direction, duration_seconds, started_at, ended_at, linked_entity_type, linked_entity_id")
      .not("external_call_id", "is", null)
      .gte("duration_seconds", 30)
      .order("started_at", { ascending: false });

    const ids = (eligible ?? []).map((c: any) => c.id);
    const { data: existingNotes } = await supabase
      .from("ai_call_notes")
      .select("call_log_id")
      .in("call_log_id", ids.length > 0 ? ids : ["00000000-0000-0000-0000-000000000000"]);
    const noted = new Set((existingNotes ?? []).map((n: any) => n.call_log_id));
    toProcess = (eligible ?? []).filter((c: any) => !noted.has(c.id)).slice(0, limit);
  }

  if (!toProcess.length) {
    logger.info("Nothing to process");
    return { processed: 0, message: "No un-noted calls" };
  }

  const owners = [...new Set(toProcess.map((c: any) => c.owner_id))];
  const tokens: Record<string, string> = {};
  const ownerLabels: Record<string, string> = {};
  for (const ownerId of owners) {
    const t = await getRCToken(supabase, ownerId);
    if (t) tokens[ownerId] = t;
    const { data: acct } = await supabase
      .from("integration_accounts")
      .select("account_label")
      .eq("owner_user_id", ownerId).eq("provider", "sms").maybeSingle();
    ownerLabels[ownerId] = acct?.account_label || "Sully Recruit";
  }

  const lookups: Record<string, Map<string, any>> = {};
  for (const ownerId of owners) {
    const token = tokens[ownerId];
    if (!token) continue;
    const ownerCalls = toProcess.filter((c: any) => c.owner_id === ownerId);
    const sorted = ownerCalls.slice().sort(
      (a: any, b: any) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime(),
    );
    const dateFrom = new Date(new Date(sorted[0].started_at).getTime() - 86400000)
      .toISOString().replace(/\.\d{3}Z$/, "Z");
    const dateTo = new Date(new Date(sorted[sorted.length - 1].started_at).getTime() + 86400000)
      .toISOString().replace(/\.\d{3}Z$/, "Z");
    const records = await fetchCallsInRange(token, dateFrom, dateTo);
    lookups[ownerId] = buildLookup(records);
    logger.info("RC lookup built", { ownerId, records: records.length, keys: lookups[ownerId].size });
  }

  const stats = {
    total: toProcess.length, processed: 0, transcribed: 0,
    no_rc_match: 0, no_recording: 0, no_transcript: 0,
    joe_error: 0, insert_error: 0, dry_run_ready: 0,
  };

  // People whose record this run enriched. The Inngest wrapper fires
  // ai/joe-says.requested for each so the brief picks up the freshly
  // extracted call intel — the call-time joe-says fire (process-ringcentral-
  // event) runs before the transcript exists, so it misses all of this.
  const joeSaysTargets: Array<{ entityId: string; entityType: "candidate" | "contact" }> = [];
  const joeSaysSeen = new Set<string>();

  for (const cl of toProcess) {
    stats.processed++;
    const token = tokens[cl.owner_id];
    if (!token) { stats.no_rc_match++; continue; }

    const rcRecord = lookups[cl.owner_id]?.get(String(cl.external_call_id));
    if (!rcRecord) { stats.no_rc_match++; continue; }

    let recordingId = rcRecord.recording?.id;
    if (!recordingId) {
      for (const leg of rcRecord.legs ?? []) {
        if (leg.recording?.id) { recordingId = leg.recording.id; break; }
      }
    }
    const contentUri = rcRecord.recording?.contentUri ?? rcRecord.legs?.[0]?.recording?.contentUri ?? null;
    if (!recordingId || !contentUri) { stats.no_recording++; continue; }

    if (payload.dry_run) {
      stats.dry_run_ready++;
      logger.info("dry-run", { call: cl.external_call_id, recording: recordingId, duration: cl.duration_seconds });
      continue;
    }

    logger.info("Downloading audio", { call: cl.external_call_id, duration: cl.duration_seconds });
    const audioResp = await fetchWithRetry(contentUri, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120000),
    }, { label: "rc-recording" });
    if (!audioResp.ok) {
      logger.warn("Audio download failed", { status: audioResp.status });
      stats.no_transcript++;
      continue;
    }
    const audioBytes = await audioResp.arrayBuffer();
    const audioContentType = audioResp.headers.get("content-type") || "audio/mpeg";
    logger.info("Audio downloaded", { bytes: audioBytes.byteLength, type: audioContentType });

    const dgResp = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&diarize=true&language=en&punctuate=true&paragraphs=true",
      {
        method: "POST",
        headers: { Authorization: `Token ${deepgramKey}`, "Content-Type": audioContentType },
        body: audioBytes,
        signal: AbortSignal.timeout(300000),
      },
    );
    if (!dgResp.ok) {
      const err = await dgResp.text().catch(() => "");
      logger.error("Deepgram failed", { status: dgResp.status, error: err.slice(0, 200) });
      stats.no_transcript++;
      continue;
    }

    const dg = await dgResp.json();
    let transcript: string | null = null;

    const paragraphs = dg.results?.channels?.[0]?.alternatives?.[0]?.paragraphs?.paragraphs;
    if (paragraphs?.length) {
      const lines = paragraphs
        .map((p: any) => {
          const speaker = p.speaker === 0 ? "Recruiter" : `Speaker ${p.speaker + 1}`;
          const text = (p.sentences ?? []).map((s: any) => s.text).join(" ");
          return text.trim() ? `${speaker}: ${text}` : null;
        })
        .filter(Boolean);
      if (lines.length) transcript = lines.join("\n");
    }
    if (!transcript) {
      transcript = dg.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? null;
    }

    if (!transcript || transcript.length < 30) {
      logger.warn("No usable transcript", { call: cl.external_call_id });
      stats.no_transcript++;
      continue;
    }

    stats.transcribed++;
    logger.info("Transcribed", { call: cl.external_call_id, chars: transcript.length });

    let entityId = cl.linked_entity_id;
    let entityType = cl.linked_entity_type;
    let entityName = "candidate";

    if (!entityId && cl.phone_number) {
      const last10 = cl.phone_number.replace(/\D/g, "").slice(-10);
      if (last10.length === 10) {
        const { data: cands } = await supabase.from("people").select("id, full_name, phone").not("phone", "is", null);
        const match = (cands ?? []).find((c: any) => c.phone?.replace(/\D/g, "").slice(-10) === last10);
        if (match) {
          entityId = match.id; entityType = "candidate"; entityName = match.full_name;
          await supabase.from("call_logs").update({
            linked_entity_type: "candidate", linked_entity_id: match.id, linked_entity_name: match.full_name,
          }).eq("id", cl.id);
        }
      }
    } else if (entityId) {
      const table = entityType === "candidate" ? "candidates" : "contacts";
      const { data: e } = await supabase.from(table).select("full_name").eq("id", entityId).maybeSingle();
      entityName = e?.full_name ?? "candidate";
    }

    const duration = `${Math.floor((cl.duration_seconds ?? 0) / 60)}m ${(cl.duration_seconds ?? 0) % 60}s`;
    let intel: Record<string, any> = {
      summary: `Call with ${entityName} (${duration}).`,
      action_items: "- Follow up manually",
    };

    try {
      const openaiKey = await getOpenAIKey();
      const { text } = await callAIWithFallback({
        anthropicKey,
        openaiKey: openaiKey || undefined,
        systemPrompt: `You are Joe — AI backbone of Sully Recruit. Extract recruiter intel from this ${duration} call with ${entityName}. Finance-aware, no fluff, but be thorough — recruiters use this as their working brief, so the more signal you pull, the better.

Return ONLY valid JSON in this exact shape:
{"summary":"...","action_items":"...","reason_for_leaving":null,"current_base":null,"current_bonus":null,"current_total":null,"target_base":null,"target_bonus":null,"target_total":null,"comp_notes":null,"current_title":null,"current_company":null,"personal_email":null,"skills":null,"notes":null,"fun_facts":null,"visa_status":null,"work_authorization":null,"relocation_preference":null,"target_locations":null,"target_roles":null,"where_interviewed":null,"where_submitted":null,"notice_period":null,"desired_start":null,"urgency":null,"decision_timeline":null,"deal_breakers":null,"counter_offer_history":null,"manager_relationship":null,"looking_to_do_next":null,"dislikes_current_role":null,"relo_details":null,"job_move_explanations":null}

Field rules:
- summary: 5–10 sentences. Cover who they are, current situation, what they're looking for, comp & timeline signals, fit concerns, red flags, and any commitments made. Strategic, not a transcript dump.
- action_items: bulleted list of concrete next steps for the recruiter. Use "- " prefix on each line. If genuinely none, return "- None".
- notes: detailed back-of-resume intel — products, business lines, divisions, function, motivations, verbatim quotes worth remembering, soft signals, personality observations, blockers. Different from summary. Null only if there is genuinely nothing to add.
- reason_for_leaving: short phrase, null if not discussed.
- current_title / current_company: short strings, null if not stated.
- current_base, current_bonus, current_total, target_base, target_bonus, target_total: MUST be a single integer (annual USD, no commas, no currency symbol, no strings, no ranges). If a range is given ("160-170k"), return the midpoint (165000). If only a vague signal ("comfortable in the 200s"), return your best single-integer estimate. Null if not discussed.
- comp_notes: anything compensation-related that doesn't fit the numeric fields — RSU vesting schedule, deferred comp, sign-on, retention bonus, carry, equity %, bonus targets, last-year actual vs. target. Null if no nuance beyond the numbers.
- personal_email: their non-work email if they explicitly shared one ("send the deck to my gmail at..."). Null if not mentioned.
- skills: short array of specific skills, products, technologies, certifications mentioned ("Python", "Bloomberg", "Series 7", "credit derivatives"). Empty array if none.
- fun_facts: hobbies, interests, personal details, family, connection points — anything to build rapport later. Null if nothing personal came up.
- visa_status: long-form sponsorship signal. "US Citizen", "Green Card", "H-1B (sponsorship needed)", "F-1/OPT (transfer required)", etc. Null if not discussed.
- work_authorization: short status string for the candidate's right to work — e.g. "Citizen", "GC", "H-1B", "F-1/OPT", "TN". Distinct from visa_status; this is the form-field summary, not the conversational detail. Null if not discussed.
- relocation_preference: short string — "Open", "No", "NYC only", "Open to East Coast", "Open with relo package". Distilled from the conversation; the conversational details go in relo_details. Null if not discussed.
- target_locations: short comma-separated list of cities or regions the candidate is targeting — "NYC, Chicago", "London", "Remote". Null if not discussed.
- target_roles: short comma-separated list of role types they're targeting — "PM, Quant", "VP credit trading", "Recruiter Director". Null if not discussed.
- where_interviewed: firms/companies they mentioned currently interviewing at (comma-separated or short prose). Null if not discussed.
- where_submitted: firms/companies they mentioned being submitted to by other recruiters. Null if not discussed.
- notice_period: how soon they can hand in notice. "2 weeks", "30 days", "immediately". Null if not discussed.
- desired_start: target start date or window separate from notice — "Sept 1", "after bonus payout in March", "Q4". Null if not discussed.
- urgency: how actively they're moving — "actively interviewing now", "exploring quietly", "passive — only for the right seat", "needs to move by Q3 for visa". Null if no signal.
- decision_timeline: how long they typically take to decide on an offer, or any deadline they've mentioned. "2 weeks once an offer lands", "needs to align with bonus", "no rush". Null if not discussed.
- deal_breakers: anything they explicitly said they won't accept — "no commute over an hour", "no role under VP", "no IB hours", "no relocation". Null if no hard requirements stated.
- counter_offer_history: whether they've been counter-offered before, what they did with it, or whether their current firm is likely to counter. Null if not discussed.
- manager_relationship: signal of their relationship with current manager — "strained", "great mentor", "exit interview already booked", "neutral". Important sourcing signal. Null if not discussed.
- looking_to_do_next: what kind of role / function / firm-type they actually want next — concrete signal of direction, not a wishlist. 1–2 sentences. Null if not discussed.
- dislikes_current_role: specific complaints about the current seat (manager, comp, scope, hours, products, culture, growth path). Verbatim or close to it where useful. Null if not discussed.
- relo_details: more than just yes/no — willingness, family situation, blocked cities, preferred geos, timing — the conversational detail behind relocation_preference. Null if not discussed.
- job_move_explanations: short prose explaining why they made each prior job change (especially short stints / gaps / lateral moves). Helps clients pre-empt questions. Null if not discussed.`,
        userContent: `Transcript:\n${transcript.slice(0, 30000)}`,
        model: "claude-sonnet-4-6",
        maxTokens: 2000,
        jsonOutput: true,
      });
      intel = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (err: any) {
      logger.warn("Joe extraction failed", { error: err.message });
      stats.joe_error++;
      intel.summary = `Call with ${entityName} (${duration}). Transcript available.`;
    }

    const toInt = (v: any): number | null => {
      if (v == null) return null;
      if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
      if (typeof v === "string") {
        const nums = v.match(/\d[\d,]*/g);
        if (!nums?.length) return null;
        const parsed = nums.map((n) => parseInt(n.replace(/,/g, ""), 10)).filter(Number.isFinite);
        if (!parsed.length) return null;
        const avg = parsed.reduce((a, b) => a + b, 0) / parsed.length;
        return Math.round(avg);
      }
      return null;
    };
    intel.current_base = toInt(intel.current_base);
    intel.current_bonus = toInt(intel.current_bonus);
    intel.current_total = toInt(intel.current_total);
    intel.target_base = toInt(intel.target_base);
    intel.target_bonus = toInt(intel.target_bonus);
    intel.target_total = toInt(intel.target_total);

    const now = new Date().toISOString();
    const { error: upsertErr } = await supabase.from("ai_call_notes").upsert({
      candidate_id: entityType === "candidate" ? entityId : null,
      contact_id: entityType === "contact" ? entityId : null,
      phone_number: cl.phone_number,
      source: "ringcentral",
      call_direction: cl.direction ?? "outbound",
      call_duration_seconds: cl.duration_seconds,
      call_duration_formatted: duration,
      transcript,
      transcription_provider: "deepgram",
      ai_summary: intel.summary,
      ai_action_items: intel.action_items,
      extracted_reason_for_leaving: intel.reason_for_leaving ?? null,
      extracted_current_base: intel.current_base ?? null,
      extracted_current_bonus: intel.current_bonus ?? null,
      extracted_target_base: intel.target_base ?? null,
      extracted_target_bonus: intel.target_bonus ?? null,
      extracted_notes: intel.notes ?? null,
      recording_url: contentUri,
      processing_status: "completed",
      external_call_id: cl.external_call_id,
      owner_id: cl.owner_id,
      call_started_at: cl.started_at,
      call_ended_at: cl.ended_at,
      call_log_id: cl.id,
      created_at: now,
    } as any, { onConflict: "external_call_id", ignoreDuplicates: false });

    if (upsertErr) {
      logger.error("Upsert failed", { error: upsertErr.message });
      stats.insert_error++;
      continue;
    }

    const clUpdate: Record<string, any> = { summary: intel.summary, updated_at: now };
    if (contentUri) clUpdate.audio_url = contentUri;
    if (entityId) { clUpdate.linked_entity_type = entityType; clUpdate.linked_entity_id = entityId; }
    await supabase.from("call_logs").update(clUpdate).eq("id", cl.id);

    if (entityId && (entityType === "candidate" || entityType === "contact")) {
      const key = `${entityType}:${entityId}`;
      if (!joeSaysSeen.has(key)) { joeSaysSeen.add(key); joeSaysTargets.push({ entityId, entityType }); }
    }

    if (entityType === "candidate" && entityId) {
      const updates: Record<string, any> = { updated_at: now };
      // Status flip at ≥60s — a substantive call earns "engaged".
      // Owner transfer waits until ≥120s — short calls (intro pings,
      // voicemail callbacks) shouldn't shuffle account ownership; a
      // 2-minute conversation is a real working session and the
      // recruiter who took it becomes the owner.
      if ((cl.duration_seconds ?? 0) >= 60) {
        updates.status = "engaged";
      }
      if ((cl.duration_seconds ?? 0) >= 120 && cl.owner_id) {
        updates.owner_user_id = cl.owner_id;
      }
      if (intel.reason_for_leaving) updates.reason_for_leaving = intel.reason_for_leaving;
      if (intel.current_base) updates.current_base_comp = intel.current_base;
      if (intel.current_bonus) updates.current_bonus_comp = intel.current_bonus;
      if (intel.current_total) updates.current_total_comp = intel.current_total;
      if (intel.target_base) updates.target_base_comp = intel.target_base;
      if (intel.target_bonus) updates.target_bonus_comp = intel.target_bonus;
      if (intel.target_total) updates.target_total_comp = intel.target_total;
      if (intel.comp_notes) updates.comp_notes = intel.comp_notes;
      if (intel.current_title) updates.current_title = intel.current_title;
      if (intel.current_company) updates.current_company = intel.current_company;
      // personal_email: only fill when blank. Recruiters may have
      // curated this manually and a misheard email on a call shouldn't
      // overwrite a known good address.
      if (intel.personal_email && typeof intel.personal_email === "string" && intel.personal_email.includes("@")) {
        const { data: existingPe } = await supabase
          .from("people")
          .select("personal_email")
          .eq("id", entityId)
          .maybeSingle();
        if (!existingPe?.personal_email) updates.personal_email = intel.personal_email.trim().toLowerCase();
      }
      // skills: merge with existing rather than overwrite. ARRAY-typed
      // column; dedupe case-insensitively.
      if (Array.isArray(intel.skills) && intel.skills.length) {
        const fresh = intel.skills.filter((s: any): s is string => typeof s === "string" && s.trim().length > 0).map((s: string) => s.trim());
        if (fresh.length) {
          const { data: existingSkills } = await supabase
            .from("people")
            .select("skills")
            .eq("id", entityId)
            .maybeSingle();
          const prior: string[] = Array.isArray(existingSkills?.skills) ? existingSkills.skills : [];
          const seen = new Set(prior.map((s) => s.toLowerCase()));
          for (const s of fresh) if (!seen.has(s.toLowerCase())) { prior.push(s); seen.add(s.toLowerCase()); }
          updates.skills = prior.slice(0, 50);
        }
      }
      if (intel.notes) updates.back_of_resume_notes = intel.notes;
      if (intel.fun_facts) updates.fun_facts = intel.fun_facts;
      if (intel.visa_status) updates.visa_status = intel.visa_status;
      if (intel.work_authorization) updates.work_authorization = intel.work_authorization;
      if (intel.relocation_preference) updates.relocation_preference = intel.relocation_preference;
      if (intel.target_locations) updates.target_locations = intel.target_locations;
      if (intel.target_roles) updates.target_roles = intel.target_roles;
      if (intel.where_interviewed) updates.where_interviewed = intel.where_interviewed;
      if (intel.where_submitted) updates.where_submitted = intel.where_submitted;
      if (intel.notice_period) updates.notice_period = intel.notice_period;

      // Rich qualitative signals live in call_structured_notes JSON
      // (no column-per-field bloat). Joe Says + Ask Joe surface them.
      const structuredKeys = [
        "looking_to_do_next",
        "dislikes_current_role",
        "relo_details",
        "job_move_explanations",
        "desired_start",
        "urgency",
        "decision_timeline",
        "deal_breakers",
        "counter_offer_history",
        "manager_relationship",
      ] as const;
      const structuredAdds: Record<string, string> = {};
      for (const k of structuredKeys) {
        const v = (intel as any)[k];
        if (v && typeof v === "string" && v.trim()) structuredAdds[k] = v.trim();
      }
      if (Object.keys(structuredAdds).length) {
        const { data: existing } = await supabase
          .from("people")
          .select("call_structured_notes")
          .eq("id", entityId)
          .maybeSingle();
        const prior = (existing?.call_structured_notes as Record<string, any> | null) ?? {};
        updates.call_structured_notes = { ...prior, ...structuredAdds, last_call_at: now };
      }

      await supabase.from("people").update(updates).eq("id", entityId);
      logger.info("Updated candidate", { name: entityName, duration: cl.duration_seconds, statusFlip: (cl.duration_seconds ?? 0) >= 60 });
    }

    // Post-call summary email to the team. Only fires for completed
    // calls ≥60s — short hangups / wrong-numbers stay out of the inbox.
    if ((cl.duration_seconds ?? 0) >= 60) {
      await sendCallSummaryEmail({
        entityName,
        entityType,
        entityId,
        ownerLabel: ownerLabels[cl.owner_id] || "Sully Recruit",
        durationFormatted: duration,
        direction: cl.direction ?? "outbound",
        phoneNumber: cl.phone_number,
        startedAt: cl.started_at,
        intel,
        callLogId: cl.id,
        logger,
      });
    }

    logger.info("Processed", {
      call: cl.external_call_id,
      candidate: entityName,
      duration: cl.duration_seconds,
      transcriptChars: transcript.length,
      summary: intel.summary?.slice(0, 80),
    });
  }

  logger.info("Batch complete", stats);
  return { ...stats, joeSaysTargets };
}

async function getRCToken(supabase: any, ownerId: string): Promise<string | null> {
  const { data } = await supabase.from("integration_accounts")
    .select("id, account_label, access_token, token_expires_at, rc_jwt, metadata")
    .eq("owner_user_id", ownerId).eq("provider", "sms").eq("is_active", true).maybeSingle();
  if (!data) return null;
  if (data.access_token && new Date(data.token_expires_at) > new Date(Date.now() + 60000)) {
    return data.access_token;
  }
  const meta = data.metadata ?? {};
  const acctLabel = data.account_label || ownerId;
  if (!data.rc_jwt || !meta.rc_client_id || !meta.rc_client_secret) {
    await notifyError({
      taskId: "process-call-deepgram",
      severity: "ERROR",
      error: new Error(`RC account ${acctLabel} is missing rc_client_id/secret or rc_jwt — re-auth required`),
      context: { accountId: data.id, accountLabel: acctLabel },
    });
    return null;
  }
  const r = await fetch(`${RC_SERVER}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${meta.rc_client_id}:${meta.rc_client_secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: data.rc_jwt,
    }),
  });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 300);
    // Don't fall back to the stale token — that just guarantees the
    // next recording fetch 401s and the call silently goes
    // un-transcribed. Surface the failure instead.
    await notifyError({
      taskId: "process-call-deepgram",
      severity: "ERROR",
      error: new Error(`RC token refresh ${r.status} for ${acctLabel} — re-auth required: ${body}`),
      context: { accountId: data.id, accountLabel: acctLabel, status: r.status },
    });
    return null;
  }
  const t = await r.json();
  await supabase.from("integration_accounts").update({
    access_token: t.access_token,
    token_expires_at: new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("owner_user_id", ownerId).eq("provider", "sms");
  return t.access_token;
}

// Locate the RC call records (to resolve each call's recording id) via the
// shared helper: account-level first, so recordings for *any* extension's
// calls are found. The old per-extension endpoint returned nothing for an
// account-owner JWT, which left every account-attributed call un-transcribed
// (silent no_rc_match). Falls back to per-extension for non-admin JWTs.
async function fetchCallsInRange(token: string, dateFrom: string, dateTo: string): Promise<any[]> {
  const { records } = await fetchRcCallLog(token, { dateFrom, dateTo, label: "rc-deepgram-lookup" });
  return records;
}

function buildLookup(records: any[]): Map<string, any> {
  const m = new Map();
  for (const r of records) {
    if (r.id) m.set(String(r.id), r);
    if (r.sessionId) m.set(String(r.sessionId), r);
    if (r.telephonySessionId) m.set(String(r.telephonySessionId), r);
  }
  return m;
}
