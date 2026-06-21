# Sully Recruit — AI-Native Roadmap

> **Status:** Recommendations / strategy doc (2026-06-21). No code shipped with
> this file. It names the concrete files and existing helpers a future
> implementation should reuse, so it doubles as an implementation brief.
>
> **Weighting:** This roadmap is deliberately weighted toward a **proactive,
> agentic Joe** — the direction chosen as the top priority.
>
> **Provider order:** Every new AI surface described here leads with **OpenAI**
> (`OpenAI → Claude → Gemini → OpenRouter`), reusing the existing
> `RESUME_PARSE_ORDER` pattern. See [§6](#6-provider-strategy-openai-first).

---

## 1. Thesis — what "AI-native" actually means here

Sully Recruit is not short on AI. There are ~23 production AI surfaces today
(resume parsing, per-reply sentiment + intel extraction, call
transcription→intel, `joe_says` briefs, `best-match-job`, and a family of
drafting endpoints), almost all riding the four-provider cascade in
`frontend/src/lib/ai-fallback.ts`.

The gap is **posture, not coverage.** AI is bolted on as a set of reactive
features the recruiter has to remember to invoke. AI-native means AI becomes the
**operating layer** of the CRM — it watches the book of business, tells the
recruiter what to do next, and (with approval) does it.

Three shifts turn Joe from a chat box into that operating layer:

| Shift | Today | AI-native |
|---|---|---|
| **Hands** | Joe is read-only (9 read tools) | Joe proposes actions and, on approval, executes them |
| **Heartbeat** | Joe only speaks when asked | Joe surfaces a ranked daily brief + per-entity next-best-action |
| **Memory** | Outcomes (placements/rejections) die in stage tables | Outcomes feed back into matching + message selection |

**Non-negotiable principle:** every Joe *write* is human-in-the-loop —
**propose → recruiter approves/edits → execute.** Joe never sends, enrolls, or
moves a stage silently, and every action path respects the existing guardrails:
`people.do_not_contact` (hard global suppression), the per-sequence send window
(`frontend/src/server-lib/send-time-calculator.ts`), the InMail credit guard,
and channel routing (Ashley has no RingCentral — never route SMS to her).

---

## 2. Current-state inventory (what already exists to reuse)

A condensed map so we build *on* the stack, not beside it.

| Capability | Where it lives | Reuse it for |
|---|---|---|
| 4-provider cascade w/ per-call `order` override | `frontend/src/lib/ai-fallback.ts` (`callAIWithFallback`) | All new LLM calls |
| Resume parse (OpenAI-first) | `parse-resume-ai.ts`, `resume-ingestion.ts` | The OpenAI-first `order` template |
| Joe assistant (SSE, 9 read tools) | `frontend/supabase/functions/ask-joe/index.ts` | Add the write-tool tier |
| Per-reply sentiment + recruiting-field extraction | `frontend/src/server-lib/intel-extraction.ts` | Signal-mining feeders |
| Call transcription → intel | `frontend/src/server-lib/call-deepgram-runner.ts`, `ai_call_notes` | Behavioral mining |
| Candidate brief (cached) | `frontend/api/lib/inngest/functions/generate-joe-says.ts` (`people.joe_says`) | Living briefs + next-best-action |
| Job↔candidate scoring | `frontend/api/lib/inngest/functions/best-match-job.ts` (`job_candidate_matches`) | Outcome learning loop |
| Drafting endpoints | `draft-sequence-message.ts`, `generate-sendout-email.ts` | `draft_and_queue_message` tool |
| Enrollment / send engine | `enrollment-init-runner.ts`, `sequence-runner.ts`, `send-channels.ts` | Action execution |
| Unified per-person timeline (13 sources) | `v_person_activity` view | Briefing + next-best-action inputs |
| Embeddings | Voyage `voyage-finance-2` → `resume_embeddings` (pgvector) | Semantic note/transcript search |

**Underused signals** (captured but not run through AI): full email threads in
`messages` (only the *latest* reply is analyzed), full call transcripts in
`ai_call_notes.transcript` (only a summary is extracted), `linkedin_profile_text`,
the `v_person_activity` timeline, and sequence-performance logs
(`sequence_step_logs.opened_at`/`open_count`).

---

## 3. Headline direction — Proactive & Agentic Joe

### Theme A — Give Joe a heartbeat (proactive)

**A1. Daily briefing (ship first — read-only, lowest risk, highest visibility).**
A new Inngest cron, `joe-daily-brief`, runs per `owner_user_id` each morning and
scans `v_person_activity`, `sequence_enrollments`, `reply_sentiment`, and the
stage tables to rank what needs attention:

- **Hot leads** — `interested`/`positive` sentiment with no follow-up logged.
- **Going cold** — `engaged` people silent for N days.
- **Stalled pipeline** — rows sitting in `submitted`/`interviewing` with no
  stage movement.
- **Replies awaiting a human** — inbound, positive, sequence auto-stopped.
- **Operational warnings** — low InMail credits, daily send caps near limit.

OpenAI (lead) ranks and writes a one-line rationale per item. Output persists to
a new `joe_briefings` table and surfaces as a **"Today" home panel** and as
Joe's opening message when the recruiter opens the assistant.

- **New:** `frontend/api/lib/inngest/functions/joe-daily-brief.ts`,
  `joe_briefings` table (migration), a `Today` panel component.
- **Reuse:** `v_person_activity`, `callAIWithFallback` (OpenAI-first order),
  Inngest cron registration pattern from existing functions.

**A2. Next-best-action chip per entity.** Each candidate / job / conversation
carries a Joe-computed recommended next step ("Send InMail re: Citadel rates
role", "Move to submitted", "Re-engage — cold 9 days"). Computed from timeline +
pipeline state + sentiment. Implement by extending the `generate-joe-says`
output with a `next_action` field (it already assembles the full person context)
rather than a separate context-gathering pass.

### Theme B — Give Joe hands (agentic, approval-gated)

Add a **write-tool tier** to `ask-joe` alongside the 9 read tools. Each write
tool **returns a proposed-action envelope — it does not perform the side
effect.** The SSE stream emits an "action card"; the frontend renders
approve / edit / reject; on confirm, the UI calls the *existing* endpoint.

| Proposed tool | Returns a proposal to… | Executes via (existing) |
|---|---|---|
| `draft_and_queue_message` | draft an email / LinkedIn / SMS | `draft-sequence-message.ts`, `generate-sendout-email.ts`, `send-channels.ts` |
| `enroll_in_sequence` | enroll a person in a sequence | `enrollment-init-runner.ts` |
| `move_pipeline_stage` | move a candidate to a stage | stage tables / `candidate_jobs` |
| `create_task` / `schedule_meeting` | create a task or meeting | `tasks` + calendar sync |
| `add_note` / `update_field` | annotate or correct a record | `people` / notes |

Guardrails enforced **before** any proposal is offered: `do_not_contact`
suppression, send window, InMail credits, SMS-routing. The model proposes; the
server still re-checks at execution time.

- **New:** write-tool definitions + action-envelope shape in
  `ask-joe/index.ts`; an `ActionCard` frontend component.
- **Deploy note:** `ask-joe` is a Supabase edge function — after editing you
  **must** run `supabase functions deploy ask-joe`; it does not ship with the
  Vercel push.

### Theme C — Agent inbox / action queue

Briefing items (A1) and Joe proposals (B) land in **one approvable queue** (a
`joe_action_queue` table) so the recruiter works a prioritized list — Approve,
Edit, Snooze, Dismiss, and **batch-approve** — instead of remembering to ask.
This is the surface that makes the product *feel* AI-native: the recruiter's day
starts in Joe's queue, not in a blank candidate list.

---

## 4. Supporting directions (feed the headline; sequence after Phase 1)

- **Activate dormant signals as Joe context.** Full-thread analysis over
  `messages` (engagement trajectory, recurring objections, ghosting), behavioral
  profiling over `ai_call_notes.transcript` (communication style, negotiation
  stance, domain depth), and LinkedIn narrative mining over
  `linkedin_profile_text`. These sharpen briefings, next-best-actions, and
  matching. Reuse the `intel-extraction.ts` extraction pattern; store
  embeddings alongside `resume_embeddings` for semantic note/transcript search.
- **Living briefs.** Make `joe_says` recency-aware and event-refreshed (on new
  call, reply, or stage change) instead of a cache that silently goes stale.
- **Outcome learning loop (later phase).** Feed `placements` / `rejections` /
  `reply_sentiment` back into `best-match-job` scoring (which candidate traits
  actually place) and into message selection (which subject lines / sequences
  actually convert, from `sequence_step_logs`).

---

## 5. Guardrails & cross-cutting AI-native principles

- **Human-in-the-loop on every write.** Propose → approve → execute. No silent
  sends, enrollments, or stage moves.
- **Compliance always wins.** `do_not_contact` and send-window/credit guards are
  re-checked server-side at execution, never trusted from the model proposal.
- **Single command surface.** Joe reachable everywhere (Cmd-K), not just a side
  panel — the briefing/queue is a first-class home surface.
- **Streaming + action cards** as the interaction primitive (extends the proven
  SSE pattern already in `ask-joe`).
- **OpenAI-first cascade kept intact** for resilience (see §6).
- **Cost/latency posture:** briefings and signal-mining are batch/cron (cheap
  model, off the critical path); interactive Joe actions get the faster
  lead model. Tune per surface via the `order`/`model` options on
  `callAIWithFallback`.

---

## 6. Provider strategy — OpenAI-first

Every new AI-native surface in this roadmap leads with **OpenAI**, with the rest
of the cascade behind it as fallback: **`OpenAI → Claude → Gemini → OpenRouter`.**
This is not a new mechanism — it's the same `order` override already used for
resume parsing (`RESUME_PARSE_ORDER` in `parse-resume-ai.ts`,
`resume-ingestion.ts`, etc.). Concretely:

- **New cron / Inngest surfaces** (`joe-daily-brief`, next-best-action, signal
  mining) pass an OpenAI-first `order` to `callAIWithFallback`
  (`frontend/src/lib/ai-fallback.ts`).
- **`ask-joe`** makes OpenAI the lead tool-running provider (it already runs
  tools via `OPENAI_TOOLS`), with Claude as the first tool-capable fallback;
  Gemini/OpenRouter remain text-only fallbacks. Because the lead model changes,
  the `ask-joe` system prompt and tool schema will need light tuning/validation.
- **Keep the full cascade** — this is a reorder of the *lead* provider for
  resilience, not removal of fallbacks. Ensure all four provider keys remain
  configured so fallback still works.

---

## 7. Phasing — impact vs. effort

| Phase | Scope | Risk | Why this order |
|---|---|---|---|
| **1 — Quick win (read-only)** | A1 daily briefing + A2 next-best-action chips | Low (no new write paths) | Proves the proactive value immediately, nothing can be sent by mistake |
| **2 — Agentic** | B write-tools with approval cards | Medium (guarded sends) | Turns insight into one-tap action once recruiters trust the briefings |
| **3 — Operating layer** | C unified action queue + outcome learning loop + dormant-signal mining | Higher | The full AI-native surface, built on trust earned in 1–2 |

**Phase 1 files to touch:** `joe-daily-brief.ts` (new Inngest fn),
`joe_briefings` migration, `Today` panel component, `generate-joe-says.ts`
(`next_action`), `ai-fallback.ts` (OpenAI-first order constant).

**Phase 2 files to touch:** `ask-joe/index.ts` (write-tools + envelopes, then
redeploy), `ActionCard` component, and the existing draft/enroll/stage endpoints
as execution targets.

---

## 8. Verification (for the eventual build)

- **Phase 1:** trigger `joe-daily-brief` manually for one `owner_user_id`,
  confirm `joe_briefings` rows are sane and the Today panel renders ranked items;
  confirm OpenAI is the provider actually hit (log the chosen provider from
  `callAIWithFallback`).
- **Phase 2:** in a staging/test record, have Joe propose each write action and
  confirm **nothing executes** until the card is approved; confirm guardrails
  block a proposal to a `do_not_contact` person and outside the send window;
  redeploy `ask-joe` and verify tool-calls run on OpenAI first.
- **Guardrail regression:** verify status enum (`new`/`reached_out`/`engaged`),
  `do_not_contact`, and Ashley-no-SMS routing are all still honored end-to-end.
