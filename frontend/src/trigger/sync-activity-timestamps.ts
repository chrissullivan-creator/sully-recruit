import { task, logger } from "@trigger.dev/sdk/v3";
import { getSupabaseAdmin } from "./lib/supabase";

/**
 * Recalculate last_reached_out_at and last_responded_at for a candidate or contact
 * by scanning messages and call_logs across all channels.
 *
 * Triggered on-demand from the frontend (CandidateDetail page).
 */
export const syncActivityTimestamps = task({
  id: "sync-activity-timestamps",
  retry: { maxAttempts: 2 },
  run: async (payload: { entity_type: "candidate" | "contact"; entity_id: string }) => {
    const supabase = getSupabaseAdmin();
    const { entity_type, entity_id } = payload;
    const table = entity_type === "candidate" ? "candidates" : "contacts";
    const idField = entity_type === "candidate" ? "candidate_id" : "contact_id";

    // 1. Get entity details
    const { data: entity, error: entityErr } = await supabase
      .from(table)
      .select("id, email, phone, linkedin_url")
      .eq("id", entity_id)
      .single();

    if (entityErr || !entity) {
      logger.error("Entity not found", { entity_type, entity_id });
      return { error: "Entity not found" };
    }

    // 2. Find messages linked to this entity
    const { data: directMessages } = await supabase
      .from("messages")
      .select("direction, sent_at, received_at, created_at")
      .eq(idField, entity_id)
      .order("created_at", { ascending: false })
      .limit(500);

    // 3. Also search messages by email address
    let emailMessages: any[] = [];
    if (entity.email) {
      const [senderRes, recipientRes] = await Promise.all([
        supabase
          .from("messages")
          .select("direction, sent_at, received_at, created_at")
          .eq("sender_address", entity.email)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase
          .from("messages")
          .select("direction, sent_at, received_at, created_at")
          .eq("recipient_address", entity.email)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      emailMessages = [...(senderRes.data || []), ...(recipientRes.data || [])];
    }

    // 4. Find call logs
    const { data: calls } = await supabase
      .from("call_logs")
      .select("direction, started_at")
      .eq("linked_entity_id", entity_id)
      .order("started_at", { ascending: false })
      .limit(100);

    // 5. Deduplicate messages
    const allMessages = [...(directMessages || []), ...emailMessages];
    const seen = new Set<string>();
    const uniqueMessages = allMessages.filter((m) => {
      const key = `${m.sent_at}|${m.received_at}|${m.direction}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // 6. Calculate timestamps
    let lastReached: string | null = null;
    let lastResponded: string | null = null;

    for (const m of uniqueMessages) {
      if (m.direction === "outbound") {
        const ts = m.sent_at || m.created_at;
        if (ts && (!lastReached || ts > lastReached)) lastReached = ts;
      } else if (m.direction === "inbound") {
        const ts = m.received_at || m.sent_at || m.created_at;
        if (ts && (!lastResponded || ts > lastResponded)) lastResponded = ts;
      }
    }

    for (const c of calls || []) {
      const ts = c.started_at;
      if (!ts) continue;
      if (c.direction === "outbound") {
        if (!lastReached || ts > lastReached) lastReached = ts;
      } else {
        if (!lastResponded || ts > lastResponded) lastResponded = ts;
      }
    }

    // 7. Update entity
    const updateData: Record<string, string> = {};
    if (lastReached) updateData.last_reached_out_at = lastReached;
    if (lastResponded) updateData.last_responded_at = lastResponded;

    if (Object.keys(updateData).length > 0) {
      await supabase.from(table).update(updateData).eq("id", entity_id);
    }

    const result = {
      last_reached_out_at: lastReached,
      last_responded_at: lastResponded,
      messages_scanned: uniqueMessages.length,
      calls_scanned: calls?.length ?? 0,
    };

    logger.info("Activity timestamps synced", result);
    return result;
  },
});
