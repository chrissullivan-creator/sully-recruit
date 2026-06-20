/**
 * Out-of-office (auto-reply) detection, return-date parsing, and the
 * person-record breadcrumb helpers.
 *
 * WHY THIS EXISTS
 * An out-of-office auto-reply is NOT a genuine human reply. The sequence
 * engine's default behaviour on any inbound message is to STOP the enrollment
 * (reply_received). For an OOO auto-responder that's wrong — we want to keep
 * the sequence alive and simply push the next touch to the day AFTER the
 * contact's stated return date.
 *
 * DETECTION HAS TWO LAYERS:
 *  1. PRIMARY — the AI intel extractor (`intel-extraction.ts`) classifies
 *     sentiment as 'ooo' and returns a structured `ooo_return_date`.
 *  2. BACKSTOP — `detectOutOfOfficeHeuristic` below: an AI-independent,
 *     deliberately conservative matcher for the unmistakable Exchange/Outlook
 *     "Automatic reply:" auto-responders. It exists so an AI-cascade outage
 *     can't cause us to (a) treat an auto-reply as a real reply and kill the
 *     sequence, or (b) keep emailing an inbox that's plainly on auto-reply.
 *
 * The pure functions (detect/parse/resolve) are unit-tested in
 * `out-of-office.test.ts`. The two `*OutOfOffice` helpers do I/O (passed a
 * supabase client) and are shared by the Microsoft + Unipile webhook
 * processors so the "note it on the record" behaviour stays identical.
 */

export interface OOODetection {
  isOOO: boolean;
  /** YYYY-MM-DD if a return date could be determined, else null. */
  returnDate: string | null;
}

// Subject signals. Outlook/Exchange prefix auto-replies with "Automatic reply:"
// — that alone is definitive. The rest cover other mail systems' wording.
const OOO_SUBJECT_RE =
  /\b(automatic reply|automated reply|auto[-\s]?reply|out of (?:the )?office|out-of-office|\booo\b|on (?:annual |parental |maternity |sick )?leave|away from (?:the )?office|vacation (?:reply|notice)|holiday (?:reply|notice))\b/i;

// Body signals — intentionally narrow to AUTO-RESPONDER phrasing so we don't
// trip on a genuine reply that merely mentions an absence ("sorry, I was out
// last week, but yes I'm interested"). Each alternative pairs an OOO phrase
// with present/future tense AND a return/qualifier cue.
const OOO_BODY_RE = new RegExp(
  [
    "\\bthis is an (?:automated|automatic) (?:reply|response|message)\\b",
    "\\bi(?: am|'m| will be) (?:currently )?out of (?:the )?office\\b",
    "\\bi(?: am|'m) (?:currently )?(?:on (?:annual |parental |maternity |sick )?leave|on (?:vacation|holiday|pto)|away from (?:the|my) (?:office|desk))\\b",
    "\\b(?:will (?:respond|reply|get back)|i will (?:respond|reply))\\b[^.]{0,40}\\b(?:upon my return|when i return|on my return|after i return)\\b",
    "\\b(?:i (?:will )?return|i'?ll be back|back in the office|returning) (?:to (?:the )?office )?on\\b",
    "\\bthank you for your (?:email|message)[^.]{0,80}\\b(?:out of (?:the )?office|currently away|on leave|limited access to (?:my )?email)\\b",
  ].join("|"),
  "i",
);

/**
 * AI-independent OOO detector. Conservative by design — a false positive means
 * we'd keep contacting someone who actually engaged, so body matches require
 * auto-responder phrasing, not a passing mention of being away.
 */
export function detectOutOfOfficeHeuristic(
  subject?: string | null,
  body?: string | null,
): OOODetection {
  const subj = (subject || "").trim();
  const text = (body || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isOOO = OOO_SUBJECT_RE.test(subj) || OOO_BODY_RE.test(text);
  if (!isOOO) return { isOOO: false, returnDate: null };
  return { isOOO: true, returnDate: parseReturnDate(text) };
}

/**
 * AI sentiments that represent a confident, genuine human reply. When the AI
 * returns one of these we trust it over the heuristic — so a candidate who is
 * clearly engaged ("out of office until Monday but very interested!") is
 * treated as a real reply (sequence stops), not an auto-reply (reschedule).
 */
const STRONG_HUMAN_SENTIMENTS = new Set([
  "interested",
  "positive",
  "negative",
  "not_interested",
  "do_not_contact",
]);

/**
 * Final OOO decision combining the AI classification with the heuristic
 * backstop. Precedence:
 *  - AI says 'ooo'                       → OOO (use AI's return date, else heuristic's)
 *  - AI made a confident human call      → NOT OOO (don't reschedule an engaged reply)
 *  - AI absent / non-committal           → defer to the heuristic
 */
export function decideOutOfOffice(
  aiSentiment: string | null | undefined,
  aiReturnDate: string | null | undefined,
  heuristic: OOODetection,
): OOODetection {
  const aiSaysHuman = !!aiSentiment && STRONG_HUMAN_SENTIMENTS.has(aiSentiment);
  const isOOO = aiSentiment === "ooo" || (!aiSaysHuman && heuristic.isOOO);
  if (!isOOO) return { isOOO: false, returnDate: null };
  return { isOOO: true, returnDate: aiReturnDate || heuristic.returnDate };
}

// ─────────────────────────────────────────────────────────────────────────────
// Return-date parsing (best-effort, AI-independent)
// ─────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

function monthIndex(token: string): number {
  const t = token.toLowerCase().slice(0, 3);
  return MONTH_NAMES.findIndex((m) => m.slice(0, 3) === t);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Return cues that, when they immediately precede a date, make it the one we want. */
const RETURN_CUE_RE =
  /\b(return(?:ing)?|back|until|through|thru|til|till|reopen|resume|rejoin|on or after|as of)\b/i;

interface DateHit {
  index: number;
  year: number | null;
  monthIdx: number;
  day: number;
}

/** Collect every date-looking token in the text, in document order. */
function collectDateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];

  // ISO yyyy-mm-dd
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    hits.push({ index: m.index ?? 0, year: Number(m[1]), monthIdx: Number(m[2]) - 1, day: Number(m[3]) });
  }
  // US m/d[/yy[yy]]
  for (const m of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g)) {
    let y: number | null = m[3] ? Number(m[3]) : null;
    if (y !== null && y < 100) y += 2000;
    hits.push({ index: m.index ?? 0, year: y, monthIdx: Number(m[1]) - 1, day: Number(m[2]) });
  }
  // Month name + day  ("January 5", "Jan 5th, 2026")
  const monthsGroup =
    "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const reMD = new RegExp(`\\b${monthsGroup}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`, "gi");
  for (const m of text.matchAll(reMD)) {
    hits.push({ index: m.index ?? 0, year: m[3] ? Number(m[3]) : null, monthIdx: monthIndex(m[1]), day: Number(m[2]) });
  }
  // Day + month name  ("5 January", "5th of Jan 2026")
  const reDM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${monthsGroup}\\.?(?:,?\\s*(\\d{4}))?`, "gi");
  for (const m of text.matchAll(reDM)) {
    hits.push({ index: m.index ?? 0, year: m[3] ? Number(m[3]) : null, monthIdx: monthIndex(m[2]), day: Number(m[1]) });
  }

  return hits.sort((a, b) => a.index - b.index);
}

/** Infer the year for a bare month/day: this year, or next if it's already behind us. */
function inferYear(monthIdx: number, day: number, now: Date): number {
  const y = now.getUTCFullYear();
  const candidate = Date.UTC(y, monthIdx, day, 12);
  return candidate < now.getTime() - 2 * MS_PER_DAY ? y + 1 : y;
}

/** Validate (year?, monthIdx, day) and return YYYY-MM-DD, or null if implausible. */
function toIsoIfValid(hit: DateHit, now: Date): string | null {
  if (hit.monthIdx < 0 || hit.monthIdx > 11 || hit.day < 1 || hit.day > 31) return null;
  const year = hit.year ?? inferYear(hit.monthIdx, hit.day, now);
  const d = new Date(Date.UTC(year, hit.monthIdx, hit.day, 12, 0, 0));
  if (isNaN(d.getTime()) || d.getUTCMonth() !== hit.monthIdx) return null; // e.g. Feb 30 rolled over
  const deltaMs = d.getTime() - now.getTime();
  if (deltaMs < -2 * MS_PER_DAY) return null;        // a return date in the past is noise
  if (deltaMs > 366 * MS_PER_DAY) return null;        // > ~1y out is noise
  return d.toISOString().slice(0, 10);
}

/**
 * Best-effort extraction of a return date from auto-reply text. Returns
 * YYYY-MM-DD or null. Prefers a date immediately preceded by a return cue
 * ("back on", "until", "returning") over an unrelated date elsewhere in the
 * signature/body.
 */
export function parseReturnDate(text: string, now: Date = new Date()): string | null {
  if (!text) return null;
  const cleaned = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const hits = collectDateHits(cleaned);
  if (hits.length === 0) return null;

  const cued = hits.filter((h) => RETURN_CUE_RE.test(cleaned.slice(Math.max(0, h.index - 30), h.index)));
  const ordered = [...cued, ...hits.filter((h) => !cued.includes(h))];

  for (const h of ordered) {
    const iso = toIsoIfValid(h, now);
    if (iso) return iso;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resume-base resolver
// ─────────────────────────────────────────────────────────────────────────────

/** Default push when we know it's OOO but can't pin a return date. */
export const DEFAULT_OOO_PUSH_DAYS = 7;

/**
 * Resolve the base instant to reschedule the next sequence step from: the day
 * AFTER the stated return date (so we don't land in the first-day-back
 * firehose). When the return date is missing or already past, push out a
 * sensible default so we don't immediately re-hit an inbox still on auto-reply.
 *
 * The result is a coarse anchor (noon UTC on the target day); callers feed it
 * through `calculateSendTime` to clamp into the sequence's send window/timezone.
 */
export function resolveOOOResumeBase(
  returnDateStr: string | null | undefined,
  now: Date = new Date(),
  defaultPushDays: number = DEFAULT_OOO_PUSH_DAYS,
): Date {
  if (returnDateStr && /^\d{4}-\d{2}-\d{2}$/.test(returnDateStr)) {
    const ret = new Date(`${returnDateStr}T12:00:00Z`);
    if (!isNaN(ret.getTime())) {
      const dayAfter = new Date(ret.getTime() + MS_PER_DAY);
      if (dayAfter.getTime() > now.getTime()) return dayAfter;
    }
  }
  return new Date(now.getTime() + defaultPushDays * MS_PER_DAY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Person-record breadcrumbs (shared I/O helpers)
// ─────────────────────────────────────────────────────────────────────────────

interface PersonMatch {
  entityId: string;
  entityType: "candidate" | "contact" | string;
}

/**
 * Note an OOO on the person record. Sets `people.ooo_until` (drives the UI
 * badge) and — for candidates — appends a dated breadcrumb to
 * `back_of_resume_notes` so the pause is visible in their timeline.
 *
 * `ooo_until` is the contact's stated RETURN date when known; otherwise the
 * computed resume instant (a best "don't expect them before" signal).
 */
export async function noteOutOfOffice(
  supabase: any,
  match: PersonMatch,
  returnDate: string | null,
  resumeAt: Date | null,
): Promise<void> {
  const oooUntil = returnDate
    ? `${returnDate}T00:00:00Z`
    : resumeAt
      ? resumeAt.toISOString()
      : null;

  await supabase.from("people").update({ ooo_until: oooUntil } as any).eq("id", match.entityId);

  if (match.entityType !== "candidate") return; // back_of_resume_notes is candidate-side

  const { data: person } = await supabase
    .from("people")
    .select("back_of_resume_notes")
    .eq("id", match.entityId)
    .maybeSingle();

  const dateStr = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const human = returnDate
    ? `out of office until ${returnDate}`
    : resumeAt
      ? `out of office (auto-reply); next touch ~${resumeAt.toISOString().slice(0, 10)}`
      : "out of office (auto-reply)";
  const note = `\n--- email auto-reply (${dateStr}) ---\nSequence kept active — ${human}. Next step rescheduled automatically.`;
  const existing = person?.back_of_resume_notes || "";
  await supabase.from("people").update({ back_of_resume_notes: existing + note } as any).eq("id", match.entityId);
}

/** Clear a stale OOO flag once the person actually responds (best-effort, single row). */
export async function clearOutOfOffice(supabase: any, match: PersonMatch): Promise<void> {
  await supabase
    .from("people")
    .update({ ooo_until: null } as any)
    .eq("id", match.entityId)
    .not("ooo_until", "is", null);
}
