import { getSupabaseAdmin, getAppSetting } from "./supabase.js";

const VOYAGE_MODEL = "voyage-finance-2";
const MAX_BODY_CHARS = 8000;

/**
 * Strip HTML tags, collapse whitespace, strip ">" quoted lines (email
 * replies), and forwarded-message headers so the embedding captures
 * original content only.
 */
function cleanBody(raw: string | null | undefined): string {
  if (!raw) return "";
  let t = raw;
  // Strip HTML tags
  t = t.replace(/<[^>]+>/g, " ");
  // Remove quoted email reply lines starting with >
  t = t
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(">"))
    .join("\n");
  // Remove forwarded-message headers
  t = t.replace(/^-{2,}\s*(Forwarded|Original)\s*(message|Message).*$/gm, "");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/**
 * Call Voyage Finance-2 to embed a text chunk. Returns null on error.
 */
async function embed(text: string, apiKey: string): Promise<number[] | null> {
  if (!text || !apiKey) return null;
  try {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: [text.slice(0, MAX_BODY_CHARS)],
        input_type: "document",
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

export interface IndexMessageArgs {
  messageId: string;
  conversationId: string;
  candidateId: string | null;
  contactId: string | null;
  channel: string;
  direction: string;
  senderName: string | null;
  subject: string | null;
  body: string | null;
  sentAt: string | null;
}

/**
 * Build a search_documents row for a single message and upsert it.
 * Strips quoted replies and HTML before embedding.
 */
export async function indexMessage(args: IndexMessageArgs): Promise<void> {
  const supabase = getSupabaseAdmin();
  const voyageKey = await getAppSetting("VOYAGE_API_KEY").catch(() => "");
  if (!voyageKey) return;

  const dirLabel = args.direction === "outbound" ? "To" : "From";
  const channelLabel = args.channel.replace("_", " ").toUpperCase();
  const title = `${dirLabel} ${args.senderName || "Unknown"} · ${channelLabel}`;
  const subtitle = args.subject ?? null;
  const cleanedBody = cleanBody(args.body);
  const combinedText = [title, subtitle, cleanedBody].filter(Boolean).join("\n");

  const embedding = await embed(combinedText, voyageKey);

  const doc = {
    source_kind: "message",
    source_id: args.messageId,
    person_id: args.candidateId || args.contactId || null,
    candidate_id: args.candidateId || null,
    contact_id: args.contactId || null,
    title,
    subtitle,
    body: cleanedBody.slice(0, 50000),
    metadata: {
      channel: args.channel,
      direction: args.direction,
      sent_at: args.sentAt,
      conversation_id: args.conversationId,
    },
    source_updated_at: args.sentAt,
    embedding,
  };

  // Upsert by (source_kind, source_id)
  const { data: existing } = await supabase
    .from("search_documents")
    .select("id")
    .eq("source_kind", "message")
    .eq("source_id", args.messageId)
    .limit(1);

  if (existing && existing.length > 0) {
    await supabase
      .from("search_documents")
      .update({ ...doc, updated_at: new Date().toISOString() } as any)
      .eq("id", existing[0].id);
  } else {
    await supabase.from("search_documents").insert(doc as any);
  }
}

export interface IndexCallArgs {
  callLogId: string;
  candidateId: string | null;
  contactId: string | null;
  direction: string;
  phoneNumber: string | null;
  entityName: string | null;
  aiSummary: string | null;
  startedAt: string | null;
}

/**
 * Build a search_documents row for a call note.
 */
export async function indexCall(args: IndexCallArgs): Promise<void> {
  const supabase = getSupabaseAdmin();
  const voyageKey = await getAppSetting("VOYAGE_API_KEY").catch(() => "");
  if (!voyageKey) return;

  const dirLabel = args.direction === "outbound" ? "Outbound call to" : "Inbound call from";
  const title = `${dirLabel} ${args.entityName || args.phoneNumber || "Unknown"}`;
  const subtitle = `CALL | ${args.direction} | ${args.phoneNumber || "Unknown number"}`;
  const body = cleanBody(args.aiSummary);
  const combinedText = [title, subtitle, body].filter(Boolean).join("\n");

  const embedding = await embed(combinedText, voyageKey);

  const doc = {
    source_kind: "call",
    source_id: args.callLogId,
    person_id: args.candidateId || args.contactId || null,
    candidate_id: args.candidateId || null,
    contact_id: args.contactId || null,
    title,
    subtitle,
    body: body.slice(0, 50000),
    metadata: {
      channel: "call",
      direction: args.direction,
      sent_at: args.startedAt,
    },
    source_updated_at: args.startedAt,
    embedding,
  };

  const { data: existing } = await supabase
    .from("search_documents")
    .select("id")
    .eq("source_kind", "call")
    .eq("source_id", args.callLogId)
    .limit(1);

  if (existing && existing.length > 0) {
    await supabase
      .from("search_documents")
      .update({ ...doc, updated_at: new Date().toISOString() } as any)
      .eq("id", existing[0].id);
  } else {
    await supabase.from("search_documents").insert(doc as any);
  }
}
