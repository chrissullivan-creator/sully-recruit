import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });

  try {
    const { entity_type, entity_id } = await req.json();
    if (!entity_id || !entity_type) return respond({ error: "entity_id and entity_type required" }, 400);

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const idCol = entity_type === "candidate" ? "candidate_id" : "contact_id";
    const table = entity_type === "candidate" ? "candidates" : "contacts";

    // Fetch all messages for this entity
    const { data: messages } = await supabase
      .from("messages")
      .select("direction, sent_at, channel")
      .eq(idCol, entity_id)
      .not("sent_at", "is", null)
      .order("sent_at", { ascending: false });

    const outbound = (messages ?? []).filter((m: any) => m.direction === "outbound");
    const inbound  = (messages ?? []).filter((m: any) => m.direction === "inbound");

    const last_contacted_at = outbound[0]?.sent_at ?? null;
    const last_responded_at = inbound[0]?.sent_at ?? null;
    const last_comm_channel  = (inbound[0] ?? outbound[0])?.channel ?? null;

    // Fetch call notes
    const { data: calls } = await supabase
      .from("ai_call_notes")
      .select("created_at")
      .eq(idCol, entity_id)
      .order("created_at", { ascending: false })
      .limit(1);

    const last_spoken_at = calls?.[0]?.created_at ?? null;

    // Build update
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (last_contacted_at) updates.last_contacted_at = last_contacted_at;
    if (last_responded_at) updates.last_responded_at = last_responded_at;
    if (last_comm_channel)  updates.last_comm_channel  = last_comm_channel;
    if (last_spoken_at && entity_type === "candidate") updates.last_spoken_at = last_spoken_at;

    const { error } = await supabase.from(table).update(updates).eq("id", entity_id);
    if (error) throw new Error(error.message);

    return respond({
      success: true,
      messages_scanned: messages?.length ?? 0,
      calls_scanned: calls?.length ?? 0,
      last_contacted_at,
      last_responded_at,
      last_comm_channel,
      last_spoken_at,
    });

  } catch (err: any) {
    console.error("[sync-activity] fatal:", err?.message);
    return respond({ error: err?.message ?? String(err) }, 500);
  }
});
