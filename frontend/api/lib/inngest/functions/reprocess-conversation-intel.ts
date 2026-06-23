import { inngest } from "../client.js";
import { getSupabaseAdmin } from "../../../../src/server-lib/supabase.js";
import {
  extractMessageIntel,
  applyExtractedIntel,
} from "../../../../src/server-lib/intel-extraction.js";

/**
 * Re-run sentiment/intel extraction when a previously-UNLINKED conversation is
 * linked to a person (the inbox "Add as candidate/client" one-click flow).
 *
 * Why: inbound messages from unknown senders now persist as unlinked (so they
 * show up in the inbox), but sentiment extraction only runs on the LINKED
 * inbound path. Without this, a brand-new sender's first message would carry no
 * sentiment until they replied again after being added. Firing this on link
 * closes that gap — it reads the latest inbound message on the conversation and
 * runs the same extract+apply the live webhook path uses.
 *
 * Fired by /api/add-person after it links the conversation + backfills the FKs.
 */
export const reprocessConversationIntel = inngest.createFunction(
  { id: "reprocess-conversation-intel", name: "Re-run intel on a freshly linked conversation", retries: 2 },
  { event: "comms/conversation.linked" },
  async ({ event, logger }) => {
    const supabase = getSupabaseAdmin();
    const { conversationId, entityId, entityType, entityColumn } = event.data as {
      conversationId: string;
      entityId: string;
      entityType: "candidate" | "contact";
      entityColumn: "candidate_id" | "contact_id";
    };
    if (!conversationId || !entityId || !entityColumn) {
      return { action: "skipped", reason: "missing_args" };
    }

    // Latest inbound message on this conversation — the one whose sentiment we
    // want surfaced now that we know who it's from.
    const { data: msg } = await supabase
      .from("messages")
      .select("body, subject, channel, created_at")
      .eq("conversation_id", conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const body = (msg?.body || "").trim();
    if (!msg || body.length <= 10) {
      return { action: "skipped", reason: "no_inbound_body" };
    }

    const intel = await extractMessageIntel(body, msg.subject || undefined);
    if (!intel) {
      return { action: "skipped", reason: "no_intel" };
    }

    // Attach to the person's most recent active enrollment if one exists, so
    // the enrollment-level sentiment denorm stays consistent (mirrors the
    // live webhook path).
    const { data: enrollment } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq(entityColumn, entityId)
      .eq("status", "active")
      .order("enrolled_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    await applyExtractedIntel(
      supabase,
      entityId,
      entityType,
      intel,
      msg.channel || "linkedin",
      enrollment?.id,
    );

    // Keep the person's last-touch fields fresh too.
    const table = entityType === "candidate" ? "candidates" : "contacts";
    await supabase
      .from(table)
      .update({ last_responded_at: msg.created_at, last_comm_channel: msg.channel } as any)
      .eq("id", entityId);

    logger.info("Reprocessed intel on linked conversation", {
      conversationId,
      entityId,
      sentiment: intel.sentiment,
    });
    return { action: "intel_applied", entityId, sentiment: intel.sentiment };
  },
);
