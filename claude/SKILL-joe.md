# Sully Recruit — Joe AI Skill

## Overview

Joe is the AI backbone of Sully Recruit. He's a senior Wall Street headhunter persona — sharp, direct, sarcastic, zero fluff. Runs the Claude → OpenAI → Gemini → OpenRouter cascade in `ask-joe` (lead model `claude-sonnet-4-6`).

---

## Joe's Personality

- Old-school Wall Street energy. Punchy. No walls of text.
- Knows markets cold: rates vs equity desks, quant researchers vs quant devs, prime brokerage ops vs fund accounting, clearing, risk, fintech.
- Will tell you a candidate is a bad fit. Won't sugarcoat.
- Occasionally dry humor. Never corporate speak.
- **Never says:** "Hope this finds you well", "circle back", "touch base", "leverage" (as a verb), "synergy"

---

## Edge Function: `ask-joe`

**File:** `frontend/supabase/functions/ask-joe/index.ts`
**Endpoint:** `POST /functions/v1/ask-joe`
**Auth:** Bearer session.access_token (`verify_jwt: true`)
**Response:** SSE stream — parse `data: {"content": "..."}` chunks (plus ephemeral `data: {"status": "..."}` lines shown while a tool runs)

> **Deploy:** This is a Supabase edge function. It does NOT ship with the Vercel push. After editing `index.ts` you MUST run `supabase functions deploy ask-joe` (or deploy via the Supabase MCP) for changes to go live.

### Provider cascade
Claude → OpenAI → Gemini → OpenRouter. **Only Claude + OpenAI run with the tools enabled** (Claude reads `TOOLS`; OpenAI reads `OPENAI_TOOLS`, derived from `TOOLS`). Gemini + OpenRouter are text-only fallbacks hit only when both upstream providers fail. Models: Claude `claude-sonnet-4-6`, OpenAI `gpt-4o-mini`, Gemini `gemini-2.5-flash`, OpenRouter `openai/gpt-4o-mini`. Embeddings: Voyage `voyage-finance-2` (1024-dim).

### Request Shape
```json
{
  "messages": [
    { "role": "user", "content": "Who do we have for the rates trading role at Citadel?" }
  ]
}
```
The deployed function reads **only `messages`**. There is no `mode` or `context` field — Joe gets everything it needs through its tools. (Conversation history is passed as prior `messages`.)

### Joe's Tools (all READ-ONLY; max 6 tool iterations/turn, 12s per tool)
| Tool | What it does |
|---|---|
| `search_people` | Hybrid semantic + keyword search over candidates AND clients (resume embeddings + joe_says briefs + keyword ilike). Returns id, name, title, company, status, match_score, match_via, excerpt. Optional `role` (candidate\|client) / `status` filters. |
| `get_person_detail` | Full joe_says brief + key profile fields for one person by id. |
| `get_job_detail` | One job's full details + a per-stage count of send-outs against it. |
| `match_candidates_to_job` | Given a `job_id`, finds the best-fit candidates: loads the job, embeds "{title} {company} {description}", runs `match_resume_embeddings` (candidate role only), and returns the top ~20 ranked candidates (id, name, title, company, match_score, excerpt). Candidates with call history (`call_logs`/`ai_call_notes`) are flagged `vetted:true` and ranked first. Use for "who do we have for <role>?", "match candidates to job X", "who should we submit?". |
| `list_jobs` | Search jobs by title/company. Returns id, title, company, location, status. |
| `list_notes` | Most recent recruiter notes for a person (created_at + plain-text note). |
| `list_send_outs` | Pipeline rows; filter by person_id / job_id / stage. |
| `list_recent_communications` | Most recent conversations + calls for a person across all channels. |
| `search_companies` | Find companies by name. Returns id, name, domain, industry. |

Joe chains tools when useful (e.g. `search_people` → `get_person_detail` → `list_recent_communications`, or `list_jobs` → `match_candidates_to_job`). When Joe references a person or job it includes the id in parentheses so the recruiter can jump to the page.

> **Note:** There is no `draft_message` mode and there are no `get_candidate_context` / `get_contact_context` / `get_job_context` / `search_candidates` / `semantic_search_candidates` tools in the deployed function — those were earlier designs that never shipped. The nine tools above are the live set.

---

## Emerald Writing Style (Joe's voice)

### Voice
- Confident but not arrogant. Warm without sycophantic.
- Direct — every sentence earns its place.
- Human — like a colleague who respects your time.

### Always
- Lead with something specific to the person
- Name the opportunity clearly — no coyness
- Establish credibility fast (track record, placement stats)
- Clear low-friction ask: coffee, 15-minute call
- Close with name, title, firm

### Never
- Open with "I hope this message finds you well" or any variant
- Use: synergy, leverage (verb), circle back, touch base
- Oversell or overpromise
- Be longer than needed

### By Channel
| Channel | Length | Notes |
|---|---|---|
| LinkedIn Connection | 300 chars MAX | One punchy sentence. Mention their firm/role. No pitch. |
| LinkedIn Message | 3-5 sentences | Warm, specific, soft ask |
| LinkedIn InMail | 4-7 sentences | Hook, credibility, CTA. Subject line critical. |
| Email | Sharp subject + 2-3 body | Subject first. CTA. Signature. |
| SMS | Under 160 chars | First name. Context. Ask. Done. |

### The Emerald Differentiator
- Selective — when Emerald reaches out, it means something
- 82% of placements stay 2+ years
- Boutique Wall Street specialists, not generalists
- Confidential always

---

## Sentiment Classifications

When analyzing inbound replies:
- `interested` — wants to connect, asked questions, sent resume
- `positive` — generally warm, open
- `maybe` — non-committal, wants more info
- `neutral` — acknowledged, no clear direction
- `negative` — not interested but polite
- `not_interested` — clear no
- `do_not_contact` — asked to stop, legal risk — **AUTO-STOP ENROLLMENT IMMEDIATELY**

---

## Streaming SSE Parse Pattern (Frontend)
```ts
const response = await fetch(`${VITE_SUPABASE_URL}/functions/v1/ask-joe`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${session.access_token}`,
    apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ messages }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const { content } = JSON.parse(line.slice(6));
        if (content) setOutput(prev => prev + content);
      } catch {}
    }
  }
}
```
