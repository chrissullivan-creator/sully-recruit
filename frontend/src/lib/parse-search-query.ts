/**
 * Inbox search operator parser.
 *
 * Tokenizes a search input into a typed ParsedQuery so the inbox
 * filter can apply per-field predicates instead of a single fuzzy
 * substring match.
 *
 * Supported operators (case-insensitive):
 *
 *   from:bob@acme.com         sender address contains "bob@acme.com"
 *   from:"bob smith"          sender NAME contains "bob smith" (quoted)
 *   to:jane@acme.com          recipient address contains
 *   channel:email             email | linkedin | recruiter | sms | call
 *   has:attachment            (alias: has:attachments) — must have attachments
 *   is:unread | is:read       read state
 *   is:flagged | is:starred   flagged true
 *   is:snoozed                currently snoozed
 *   is:archived               archived
 *   is:awaiting               awaiting reply (no inbound yet)
 *   is:replied                last message inbound
 *   before:2026-05-01         last activity strictly before this date (YYYY-MM-DD)
 *   after:2026-05-01          last activity on/after this date
 *
 * Anything left over after operators are extracted is the "free text"
 * which matches across subject, preview, sender name, and the linked
 * person's name.
 *
 * Quoted strings ("...") are preserved as a single token even with
 * spaces inside.
 */

export interface ParsedQuery {
  freeText: string;
  from: string[];      // each entry matches substring against sender_name or sender_address
  to: string[];        // recipient address substring
  channels: string[];  // normalized channel values
  hasAttachment: boolean | null;
  isUnread: boolean | null;
  isFlagged: boolean | null;
  isSnoozed: boolean | null;
  isArchived: boolean | null;
  isAwaiting: boolean | null;
  isReplied: boolean | null;
  before: Date | null;
  after: Date | null;
}

const EMPTY: ParsedQuery = {
  freeText: '',
  from: [],
  to: [],
  channels: [],
  hasAttachment: null,
  isUnread: null,
  isFlagged: null,
  isSnoozed: null,
  isArchived: null,
  isAwaiting: null,
  isReplied: null,
  before: null,
  after: null,
};

const CHANNEL_ALIASES: Record<string, string[]> = {
  email: ['email'],
  linkedin: ['linkedin'],
  recruiter: ['linkedin_recruiter'],
  inmail: ['linkedin_recruiter'],
  sms: ['sms'],
  text: ['sms'],
  call: ['call'],
  phone: ['call'],
};

/**
 * Split the query into tokens, respecting double-quoted spans.
 * "from:\"bob smith\" hello" → [ 'from:bob smith', 'hello' ]
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  const re = /([a-zA-Z_]+:)?(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const prefix = m[1] ?? '';
    const value = m[2] ?? m[3] ?? '';
    tokens.push(`${prefix}${value}`);
  }
  return tokens;
}

function parseDate(s: string): Date | null {
  // Accept YYYY-MM-DD; reject anything else so we don't false-match dates
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseSearchQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim();
  if (!trimmed) return { ...EMPTY };

  const out: ParsedQuery = { ...EMPTY, from: [], to: [], channels: [] };
  const freeTextParts: string[] = [];

  for (const token of tokenize(trimmed)) {
    const colon = token.indexOf(':');
    if (colon <= 0) {
      freeTextParts.push(token);
      continue;
    }
    const op = token.slice(0, colon).toLowerCase();
    const value = token.slice(colon + 1);
    if (!value) continue;

    switch (op) {
      case 'from':
        out.from.push(value.toLowerCase());
        break;
      case 'to':
        out.to.push(value.toLowerCase());
        break;
      case 'channel':
      case 'in': {
        const v = value.toLowerCase();
        const mapped = CHANNEL_ALIASES[v];
        if (mapped) out.channels.push(...mapped);
        else out.channels.push(v); // permissive — let the consumer no-op on unknowns
        break;
      }
      case 'has': {
        const v = value.toLowerCase();
        if (v === 'attachment' || v === 'attachments') out.hasAttachment = true;
        break;
      }
      case 'is': {
        const v = value.toLowerCase();
        if (v === 'unread') out.isUnread = true;
        else if (v === 'read') out.isUnread = false;
        else if (v === 'flagged' || v === 'starred') out.isFlagged = true;
        else if (v === 'snoozed') out.isSnoozed = true;
        else if (v === 'archived') out.isArchived = true;
        else if (v === 'awaiting' || v === 'awaiting_reply') out.isAwaiting = true;
        else if (v === 'replied') out.isReplied = true;
        break;
      }
      case 'before': {
        const d = parseDate(value);
        if (d) out.before = d;
        else freeTextParts.push(token); // unrecognized → treat literally
        break;
      }
      case 'after':
      case 'since': {
        const d = parseDate(value);
        if (d) out.after = d;
        else freeTextParts.push(token);
        break;
      }
      default:
        freeTextParts.push(token);
    }
  }

  out.freeText = freeTextParts.join(' ').trim().toLowerCase();
  return out;
}

/**
 * Apply a ParsedQuery to a thread row. Returns true if the row passes
 * every active predicate. Free text matches subject, preview, sender
 * name, and the linked person's name (case-insensitive contains).
 */
export interface MatchableThread {
  subject?: string | null;
  last_message_preview?: string | null;
  last_inbound_preview?: string | null;
  candidate_name?: string | null;
  contact_name?: string | null;
  channel?: string | null;
  is_read?: boolean | null;
  is_archived?: boolean | null;
  flagged?: boolean | null;
  snoozed_until?: string | null;
  has_attachments?: boolean | null;
  last_message_at?: string | null;
  last_inbound_at?: string | null;
  status?: string | null;
}

export function matchesParsedQuery(t: MatchableThread, q: ParsedQuery): boolean {
  if (q.channels.length > 0 && !q.channels.includes(t.channel ?? '')) return false;

  if (q.hasAttachment !== null && !!t.has_attachments !== q.hasAttachment) return false;

  if (q.isUnread !== null) {
    const unread = !t.is_read;
    if (unread !== q.isUnread) return false;
  }
  if (q.isFlagged !== null && !!t.flagged !== q.isFlagged) return false;
  if (q.isArchived !== null && !!t.is_archived !== q.isArchived) return false;
  if (q.isSnoozed !== null) {
    const snoozed = !!(t.snoozed_until && new Date(t.snoozed_until).getTime() > Date.now());
    if (snoozed !== q.isSnoozed) return false;
  }
  if (q.isAwaiting !== null) {
    const aw = !t.last_inbound_at && !!t.last_message_at;
    if (aw !== q.isAwaiting) return false;
  }
  if (q.isReplied !== null) {
    const replied = t.status === 'replied' || (!!t.last_inbound_at && !!t.last_message_at && new Date(t.last_inbound_at) >= new Date(t.last_message_at));
    if (replied !== q.isReplied) return false;
  }

  const activityIso = t.last_inbound_at ?? t.last_message_at ?? null;
  if (q.before && activityIso) {
    if (new Date(activityIso).getTime() >= q.before.getTime()) return false;
  }
  if (q.after && activityIso) {
    if (new Date(activityIso).getTime() < q.after.getTime()) return false;
  }
  // If date filters set but the row has no activity, drop it.
  if ((q.before || q.after) && !activityIso) return false;

  // from: matches sender name OR address from linked person name as a
  // best-effort proxy (the row doesn't carry sender_address directly).
  if (q.from.length > 0) {
    const hay = [t.candidate_name, t.contact_name, t.last_inbound_preview, t.last_message_preview]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!q.from.every((f) => hay.includes(f))) return false;
  }
  // to: doesn't have a direct field on the row; for now it falls
  // through to free-text. (When we surface recipient_address on the
  // view we'll wire it in.)
  if (q.to.length > 0) {
    const hay = [t.subject, t.last_message_preview]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    if (!q.to.every((toVal) => hay.includes(toVal))) return false;
  }

  if (q.freeText) {
    const hay = [
      t.subject,
      t.last_message_preview,
      t.last_inbound_preview,
      t.candidate_name,
      t.contact_name,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    // Tokenize free text by whitespace; all tokens must appear
    // (AND semantics — same as Gmail).
    const terms = q.freeText.split(/\s+/);
    if (!terms.every((term) => hay.includes(term))) return false;
  }

  return true;
}
