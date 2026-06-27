import { inngest } from "../client.js";
import {
  getSupabaseAdmin,
  getAppSetting,
  getAnthropicKey,
  getOpenAIKey,
  getGeminiKey,
  getOpenRouterKey,
} from "../../../../src/server-lib/supabase.js";
import { callAIWithFallback, RESUME_PARSE_ORDER } from "../../../../src/lib/ai-fallback.js";

/**
 * Phase 1 of the AI-native roadmap — Proactive Joe.
 *
 * Each morning, per recruiter (`people.owner_user_id`), surface the handful of
 * people that need attention today and write them to `joe_briefings` as a
 * ranked "Today / For You" feed. READ-ONLY: this function never sends a
 * message, moves a stage, or contacts anyone — it only reads signals and
 * writes briefing rows the recruiter can act on by hand.
 *
 * Gated behind the `JOE_PROACTIVE_ENABLED` app_setting (default false), so it
 * is inert in production until explicitly switched on.
 *
 * Provider order is OpenAI-first (reusing RESUME_PARSE_ORDER) per the roadmap;
 * if every provider fails we fall back to deterministic headlines so a model
 * outage can't leave the feed empty.
 */

const COLD_DAYS = 10; // silent at least this long to count as "going cold"
const COLD_MAX_DAYS = 60; // ...but not older than this — a 10-month-cold contact
// isn't "going cold", it's gone. Keep the feed to people worth re-engaging now.
const MAX_PER_OWNER = 25; // cap signals ranked + written per recruiter per day

type Category = "hot_lead" | "going_cold" | "reply_waiting";

interface Signal {
  owner_user_id: string;
  entity_type: "candidate" | "client";
  entity_id: string;
  category: Category;
  name: string;
  title: string | null;
  company: string | null;
  sentiment: string | null;
  base_score: number;
  fact: string; // raw fact handed to the model / used for the fallback headline
}

function entityTypeFor(personType: string | null): "candidate" | "client" {
  return personType === "client" ? "client" : "candidate";
}

/** Collect attention-worthy people for all recruiters from the `people` table. */
async function gatherSignals(supabase: any, logger: any): Promise<Signal[]> {
  const signals: Signal[] = [];
  const coldCutoff = new Date(Date.now() - COLD_DAYS * 86_400_000).toISOString();
  const coldFloor = new Date(Date.now() - COLD_MAX_DAYS * 86_400_000).toISOString();

  // Warm repliers awaiting our move: they replied with positive/interested/maybe
  // sentiment and we haven't sent anything since their reply.
  const { data: warm, error: warmErr } = await supabase
    .from("people")
    .select(
      "id, type, owner_user_id, full_name, first_name, last_name, current_title, current_company, last_sequence_sentiment, last_responded_at, last_contacted_at",
    )
    .in("last_sequence_sentiment", ["interested", "positive", "maybe"])
    .not("last_responded_at", "is", null)
    .not("owner_user_id", "is", null)
    .eq("do_not_contact", false)
    .order("last_responded_at", { ascending: false })
    .limit(400);
  if (warmErr) logger.warn("joe-daily-brief: warm query failed", { error: warmErr.message });

  for (const p of warm ?? []) {
    const awaitingUs =
      !p.last_contacted_at ||
      (p.last_responded_at && p.last_responded_at >= p.last_contacted_at);
    if (!awaitingUs) continue;
    const hot = p.last_sequence_sentiment === "interested" || p.last_sequence_sentiment === "positive";
    signals.push({
      owner_user_id: p.owner_user_id,
      entity_type: entityTypeFor(p.type),
      entity_id: p.id,
      category: hot ? "hot_lead" : "reply_waiting",
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown",
      title: p.current_title ?? null,
      company: p.current_company ?? null,
      sentiment: p.last_sequence_sentiment ?? null,
      base_score: hot ? 90 : 70,
      fact: `Replied (${p.last_sequence_sentiment}) and is awaiting a follow-up; last reply ${p.last_responded_at}.`,
    });
  }

  // Going cold: engaged people who've gone quiet for COLD_DAYS+.
  const { data: cold, error: coldErr } = await supabase
    .from("people")
    .select(
      "id, type, owner_user_id, full_name, first_name, last_name, current_title, current_company, last_sequence_sentiment, last_responded_at",
    )
    .eq("status", "engaged")
    .not("owner_user_id", "is", null)
    .eq("do_not_contact", false)
    .lt("last_responded_at", coldCutoff)
    .gte("last_responded_at", coldFloor) // only the last ~2 months — skip dead-cold
    .order("last_responded_at", { ascending: false }) // freshest-cold first
    .limit(400);
  if (coldErr) logger.warn("joe-daily-brief: cold query failed", { error: coldErr.message });

  const already = new Set(signals.map((s) => s.entity_id));
  for (const p of cold ?? []) {
    if (already.has(p.id)) continue; // a warm reply-waiting takes precedence
    signals.push({
      owner_user_id: p.owner_user_id,
      entity_type: entityTypeFor(p.type),
      entity_id: p.id,
      category: "going_cold",
      name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || "Unknown",
      title: p.current_title ?? null,
      company: p.current_company ?? null,
      sentiment: p.last_sequence_sentiment ?? null,
      base_score: 50,
      fact: `Engaged but silent since ${p.last_responded_at} — at risk of going cold.`,
    });
  }

  return signals;
}

const CATEGORY_LABEL: Record<Category, string> = {
  hot_lead: "Hot lead",
  reply_waiting: "Reply waiting",
  going_cold: "Going cold",
};

/** Deterministic headline used as the fallback when the model is unavailable. */
function fallbackHeadline(s: Signal): string {
  const who = s.title && s.company ? `${s.name} (${s.title}, ${s.company})` : s.name;
  switch (s.category) {
    case "hot_lead":
      return `Follow up with ${who} — replied warm, ball's in our court`;
    case "reply_waiting":
      return `${who} replied and is waiting on us`;
    case "going_cold":
      return `Re-engage ${who} — engaged but gone quiet`;
  }
}

const RANK_PROMPT = `You are Joe, a sharp Wall Street headhunter running a recruiter's morning briefing.
You'll get a JSON array of attention items (people who need a recruiter's action today).
Return ONLY a JSON object: { "items": [ { "entity_id", "score", "headline", "rationale" } ] }.
- score: 0-100 priority (higher = act sooner). Respect the category signal but use judgment.
- headline: one punchy line (<= 90 chars) telling the recruiter the action to take. No fluff, no greetings.
- rationale: one short sentence on why now.
Keep every entity_id from the input. No prose outside the JSON.`;

interface RankedItem {
  entity_id: string;
  score: number;
  headline: string;
  rationale: string;
}

async function rankWithAI(
  signals: Signal[],
  keys: { anthropicKey: string; openaiKey: string; geminiKey: string; openRouterKey: string },
  logger: any,
): Promise<Map<string, RankedItem>> {
  const out = new Map<string, RankedItem>();
  if (!signals.length) return out;
  try {
    const input = signals.map((s) => ({
      entity_id: s.entity_id,
      category: s.category,
      who: [s.name, s.title, s.company].filter(Boolean).join(" · "),
      sentiment: s.sentiment,
      fact: s.fact,
    }));
    const { text } = await callAIWithFallback({
      anthropicKey: keys.anthropicKey || undefined,
      openaiKey: keys.openaiKey || undefined,
      geminiKey: keys.geminiKey || undefined,
      openRouterKey: keys.openRouterKey || undefined,
      order: RESUME_PARSE_ORDER, // OpenAI-first
      systemPrompt: RANK_PROMPT,
      userContent: JSON.stringify(input),
      maxTokens: 2000,
      temperature: 0,
      jsonOutput: true,
    });
    const parsed = JSON.parse(text || "{}");
    for (const it of parsed.items ?? []) {
      if (it?.entity_id) out.set(String(it.entity_id), it as RankedItem);
    }
  } catch (err: any) {
    logger.warn("joe-daily-brief: AI ranking failed, using deterministic headlines", {
      error: err?.message,
    });
  }
  return out;
}

export const joeDailyBrief = inngest.createFunction(
  {
    id: "joe-daily-brief",
    name: "Joe daily briefing (proactive, read-only)",
    retries: 1,
  },
  { cron: "0 11 * * *" }, // ~6-7am America/New_York
  async ({ logger }) => {
    const flag = (await getAppSetting("JOE_PROACTIVE_ENABLED").catch(() => "false"))
      .trim()
      .toLowerCase();
    if (!(flag === "true" || flag === "1" || flag === "yes" || flag === "on")) {
      return { skipped: true, reason: "JOE_PROACTIVE_ENABLED is off" };
    }

    const supabase = getSupabaseAdmin();
    const [anthropicKey, openaiKey, geminiKey, openRouterKey] = await Promise.all([
      getAnthropicKey().catch(() => ""),
      getOpenAIKey().catch(() => ""),
      getGeminiKey().catch(() => ""),
      getOpenRouterKey().catch(() => ""),
    ]);

    const allSignals = await gatherSignals(supabase, logger);
    if (!allSignals.length) {
      return { owners: 0, written: 0, reason: "no signals" };
    }

    // Group by recruiter and cap per owner (highest base_score first).
    const byOwner = new Map<string, Signal[]>();
    for (const s of allSignals) {
      const arr = byOwner.get(s.owner_user_id) ?? [];
      arr.push(s);
      byOwner.set(s.owner_user_id, arr);
    }

    let written = 0;
    const briefDate = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
    )
      .toISOString()
      .slice(0, 10);

    for (const [ownerId, ownerSignals] of byOwner) {
      const top = ownerSignals
        .sort((a, b) => b.base_score - a.base_score)
        .slice(0, MAX_PER_OWNER);
      const ranked = await rankWithAI(top, { anthropicKey, openaiKey, geminiKey, openRouterKey }, logger);

      const rows = top.map((s) => {
        const r = ranked.get(s.entity_id);
        return {
          owner_user_id: ownerId,
          brief_date: briefDate,
          entity_type: s.entity_type,
          entity_id: s.entity_id,
          category: s.category,
          headline: (r?.headline || fallbackHeadline(s)).slice(0, 200),
          rationale: r?.rationale || `${CATEGORY_LABEL[s.category]}. ${s.fact}`,
          score: Number.isFinite(r?.score) ? Math.round(r!.score) : s.base_score,
          status: "open",
        };
      });

      const { error } = await supabase
        .from("joe_briefings" as any)
        .upsert(rows, {
          onConflict: "owner_user_id,brief_date,entity_type,entity_id,category",
        });
      if (error) {
        logger.error("joe-daily-brief: upsert failed", { ownerId, error: error.message });
        continue;
      }
      written += rows.length;
    }

    logger.info("joe-daily-brief: done", { owners: byOwner.size, written });
    return { owners: byOwner.size, written };
  },
);
