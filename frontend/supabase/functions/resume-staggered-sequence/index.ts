import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SEQUENCE_ID = "64cbde4b-af6c-4e4b-9cf5-c7f4fbe3360d";
const SEQUENCE_START = "2026-03-29T22:00:00Z"; // only count replies after enrollment
const STAGGER_MINUTES = 7;

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: enrollments, error } = await supabase
    .from("sequence_enrollments")
    .select("id, candidate_id, contact_id, enrolled_at")
    .eq("sequence_id", SEQUENCE_ID)
    .eq("status", "paused")
    .order("enrolled_at", { ascending: true });

  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: cors });

  const now = new Date();
  let resumed = 0, skipped_replied = 0;
  const skipped_names: string[] = [];
  let staggerIndex = 0;

  for (const enrollment of enrollments ?? []) {
    const personId = enrollment.candidate_id ?? enrollment.contact_id;
    if (!personId) continue;
    const isCandidate = !!enrollment.candidate_id;

    // Only block if they replied AFTER the sequence started
    const enrolledAt = enrollment.enrolled_at ?? SEQUENCE_START;
    const { data: replies } = await supabase
      .from("messages")
      .select("id, channel, sent_at")
      .eq(isCandidate ? "candidate_id" : "contact_id", personId)
      .eq("direction", "inbound")
      .gte("sent_at", enrolledAt)  // only replies AFTER enrollment date
      .limit(1);

    if (replies && replies.length > 0) {
      // Replied after enrollment — stop, don't send
      await supabase.from("sequence_enrollments").update({
        status: "stopped",
        stopped_reason: "reply_received",
        stopped_at: now.toISOString(),
        updated_at: now.toISOString(),
      }).eq("id", enrollment.id);

      const { data: person } = await supabase
        .from(isCandidate ? "candidates" : "contacts")
        .select("full_name, first_name, last_name")
        .eq("id", personId).single();
      const name = (person as any)?.full_name ||
        `${(person as any)?.first_name ?? ""} ${(person as any)?.last_name ?? ""}`.trim();
      skipped_names.push(`${name} (via ${replies[0].channel})`);
      skipped_replied++;
      continue;
    }

    // No post-enrollment reply — stagger and resume
    const sendAt = new Date(now.getTime() + staggerIndex * STAGGER_MINUTES * 60 * 1000);
    await supabase.from("sequence_enrollments").update({
      status: "active",
      paused_at: null,
      next_step_at: sendAt.toISOString(),
      updated_at: now.toISOString(),
    }).eq("id", enrollment.id);

    staggerIndex++;
    resumed++;
  }

  // Reactivate sequence
  await supabase.from("sequences").update({ status: "active" }).eq("id", SEQUENCE_ID);

  const lastSendAt = staggerIndex > 0
    ? new Date(now.getTime() + (staggerIndex - 1) * STAGGER_MINUTES * 60 * 1000)
    : now;

  console.log(`[resume] resumed=${resumed} skipped_replied=${skipped_replied} names=${JSON.stringify(skipped_names)}`);

  return new Response(JSON.stringify({
    ok: true,
    resumed,
    skipped_already_replied: skipped_replied,
    skipped_names,
    first_send: now.toISOString(),
    last_send: lastSendAt.toISOString(),
    stagger_minutes: STAGGER_MINUTES,
  }), { headers: { ...cors, "Content-Type": "application/json" } });
});
