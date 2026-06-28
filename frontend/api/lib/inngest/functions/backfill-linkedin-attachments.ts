import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import { fetchAndUploadLinkedinAttachments } from "../../linkedin-attachments.js";

/**
 * Backfill LinkedIn / InMail message attachments.
 *
 * The webhook payload for a LinkedIn message already carries its file
 * attachments (résumés etc.) under `raw_payload.attachments[]`, but until the
 * ingestion fix those bytes were never downloaded — `messages.attachments`
 * stayed `[]`, so the inbox showed the text with no résumé. This re-reads the
 * stored payload for any such message and pulls the files into Storage, exactly
 * like the live path now does, then stamps `messages.attachments`.
 *
 * Idempotent: only touches rows whose `attachments` column is still empty, and
 * Storage uploads are upsert. Daily safety-net cron + an event trigger for a
 * one-off run:
 *   await inngest.send({ name: "ops/backfill-linkedin-attachments.requested",
 *     data: { limit: 500 } });
 */

interface BackfillPayload {
  limit?: number;
}

const DEFAULT_LIMIT = 500;
const CONCURRENCY = 3;

async function backfillOnce(payload: BackfillPayload, logger: any) {
  const supabase = getSupabaseAdmin();
  const limit = payload.limit ?? DEFAULT_LIMIT;

  // Messages with attachment metadata in the raw payload but nothing fetched.
  // jsonb filters: raw_payload ? 'attachments' AND it's a non-empty array AND
  // the attachments column is null/empty. PostgREST can't express the array
  // length easily, so pull candidates by the cheap filters and refine in JS.
  const { data: rows, error } = await supabase
    .from("messages")
    .select("id, conversation_id, raw_payload, attachments")
    .like("channel", "linkedin%")
    .not("raw_payload", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit * 6); // over-fetch; most rows have no attachments
  if (error) throw new Error(`Message lookup failed: ${error.message}`);

  const candidates = (rows ?? []).filter((m: any) => {
    const a = m.raw_payload?.attachments;
    const hasPayloadAtts = Array.isArray(a) && a.length > 0;
    const already = Array.isArray(m.attachments) && m.attachments.length > 0;
    return hasPayloadAtts && !already && m.conversation_id;
  }).slice(0, limit);

  if (candidates.length === 0) {
    logger.info("No LinkedIn messages need attachment backfill");
    return { scanned: rows?.length ?? 0, processed: 0, withFiles: 0, errors: 0 };
  }

  let processed = 0;
  let withFiles = 0;
  let errors = 0;

  const processOne = async (m: any) => {
    try {
      const stored = await fetchAndUploadLinkedinAttachments(
        supabase, m.raw_payload, m.conversation_id, logger,
      );
      if (stored.length > 0) {
        const { error: upErr } = await supabase
          .from("messages")
          .update({ attachments: stored } as any)
          .eq("id", m.id);
        if (upErr) { errors++; return; }
        withFiles++;
      }
      processed++;
    } catch (err: any) {
      errors++;
      logger.warn("Attachment backfill failed for message", { id: m.id, error: err?.message });
    }
  };

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(candidates.slice(i, i + CONCURRENCY).map(processOne));
  }

  const summary = { scanned: rows?.length ?? 0, candidates: candidates.length, processed, withFiles, errors };
  logger.info("LinkedIn attachment backfill complete", summary);
  return summary;
}

export const backfillLinkedinAttachmentsDaily = inngest.createFunction(
  { id: "backfill-linkedin-attachments-daily", name: "Backfill LinkedIn attachments (daily, Inngest)" },
  { cron: "30 6 * * *" },
  async ({ logger }) => backfillOnce({ limit: 300 }, logger),
);

export const backfillLinkedinAttachmentsOnce = inngest.createFunction(
  { id: "backfill-linkedin-attachments-once", name: "Backfill LinkedIn attachments (one-off, Inngest)" },
  { event: "ops/backfill-linkedin-attachments.requested" },
  async ({ event, logger }) => backfillOnce(event.data ?? {}, logger),
);
