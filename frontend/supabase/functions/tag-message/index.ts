import Anthropic from 'npm:@anthropic-ai/sdk';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? Deno.env.get('anthropic_api_key');

const VALID_TAGS = [
  'positive_response',
  'declined',
  'interview_confirmed',
  'interview_completed',
  'offer_discussed',
  'offer_accepted',
  'offer_declined',
  'client_feedback_positive',
  'client_feedback_negative',
  'ghosted',
  'send_out_request',
  'scheduling_request',
  'reference_to_compensation',
  'withdrawal',
];

const SYSTEM_PROMPT = `You are Joe, a sharp Wall Street recruiter AI. You read messages between recruiters and candidates or clients, and tag them with relevant labels.

Return ONLY valid JSON — no preamble, no markdown.

Format:
{
  "tags": ["tag1", "tag2"],
  "confidence": {"tag1": 0.95, "tag2": 0.82},
  "summary": "One sentence summary of the message",
  "stage_suggestion": "send_out | submitted | interviewing | offer | placed | rejected | withdrawn | null",
  "stage_confidence": 0.85,
  "stage_reasoning": "Why you suggest this stage or null"
}

Valid tags: ${VALID_TAGS.join(', ')}

Only tag what is clearly present. Do not over-tag.`;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FALLBACK = {
  tags: [] as string[],
  confidence: {} as Record<string, number>,
  summary: '',
  stage_suggestion: null as string | null,
  stage_confidence: 0,
  stage_reasoning: null as string | null,
};

// Pull the first JSON object out of a noisy string (handles ```json fences,
// preambles, trailing prose). Returns null if nothing parseable was found.
function extractJson(raw: string): any | null {
  if (!raw) return null;
  // Strip code fences first — the most common Claude habit.
  const fenced = raw.replace(/```json|```/g, '').trim();
  // Try a straight parse on the cleaned string.
  try { return JSON.parse(fenced); } catch { /* fall through */ }
  // Last resort: find the first {...} block via a simple brace match.
  const start = fenced.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < fenced.length; i++) {
    const c = fenced[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(fenced.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // Always return 200 — this function is called by a pg_net trigger fire-and-forget;
  // surfacing 500s just spams logs and pg_net retries. We embed any error in the body.
  const ok = (data: any, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ ...data, ...extra }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const { message_id, body, subject, channel, direction, candidate_name, job_title } = await req.json();

    if (!body && !subject) return ok(FALLBACK, { skipped: 'no_content' });
    if (!ANTHROPIC_API_KEY) return ok(FALLBACK, { skipped: 'no_api_key' });

    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    const userPrompt = `Message context:\n- Channel: ${channel ?? 'unknown'}\n- Direction: ${direction ?? 'unknown'} (inbound = from candidate/client, outbound = from recruiter)\n- Candidate: ${candidate_name ?? 'unknown'}\n- Job: ${job_title ?? 'unknown'}\n${subject ? `- Subject: ${subject}` : ''}\n\nMessage body:\n${(body ?? '').slice(0, 8000)}`;

    let raw = '';
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
    } catch (modelErr) {
      console.error('tag-message: Anthropic call failed:', modelErr);
      return ok(FALLBACK, { skipped: 'model_error', error: (modelErr as any)?.message });
    }

    const parsed = extractJson(raw);
    const result = parsed ?? FALLBACK;
    if (!parsed) console.warn('tag-message: failed to extract JSON. Raw=', raw.slice(0, 200));

    if (message_id && parsed) {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseUrl && supabaseKey) {
        try {
          await fetch(`${supabaseUrl}/rest/v1/messages?id=eq.${message_id}`, {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Prefer': 'return=minimal',
            },
            body: JSON.stringify({
              ai_tags: result.tags,
              ai_tag_confidence: result.confidence,
              ai_tag_summary: result.summary,
              ai_tagged_at: new Date().toISOString(),
            }),
          });

          if (result.stage_suggestion && result.stage_confidence > 0.75) {
            const msgRes = await fetch(`${supabaseUrl}/rest/v1/messages?id=eq.${message_id}&select=send_out_id,candidate_id`, {
              headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
            });
            const msgs = await msgRes.json();
            const msg = msgs[0];
            if (msg?.send_out_id) {
              await fetch(`${supabaseUrl}/rest/v1/stage_transitions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'apikey': supabaseKey,
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Prefer': 'return=minimal',
                },
                body: JSON.stringify({
                  entity_type: 'send_out',
                  entity_id: msg.send_out_id,
                  to_stage: result.stage_suggestion,
                  moved_by: 'ai',
                  trigger_source: 'ai_tag',
                  triggered_by_message_id: message_id,
                  ai_reasoning: result.stage_reasoning,
                  ai_confidence: result.stage_confidence,
                }),
              });
            }
          }
        } catch (writeErr) {
          console.error('tag-message: write-back failed:', writeErr);
          // still return 200 — caller (trigger) doesn't need to know
        }
      }
    }

    return ok(result);
  } catch (err) {
    console.error('tag-message error:', err);
    return ok(FALLBACK, { skipped: 'unhandled', error: (err as any)?.message });
  }
});
