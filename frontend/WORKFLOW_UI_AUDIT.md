# Workflow Buttons & UI Structure Audit (Ask Joe CRM/ATS)

Date: 2026-05-08
Scope reviewed:
- `frontend/src/pages/AskJoe.tsx`
- `frontend/src/pages/SequenceBuilder.tsx`
- `frontend/src/pages/Candidates.tsx`
- `frontend/src/pages/Contacts.tsx`
- `frontend/src/pages/Index.tsx`

## Executive Summary

The product already has strong momentum: clear workflow surfaces (Ask Joe, Sequences, list pages), lightweight visual hierarchy, and domain-focused actions. The biggest UX opportunities are around **button consistency**, **workflow-state clarity**, and **action prioritization for recruiter speed**.

For a Wall Street staffing workflow, every extra click costs throughput. The UI should bias toward:
1. primary actions being obvious,
2. AI actions being contextual (not competing with core workflow actions),
3. explicit “what happens next” confirmations.

---

## 1) Button System Audit

## What’s working
- Reusable `Button` component is used across key pages, giving a base level of consistency.
- Ask Joe uses clear visual differentiation for high-intent action (`variant="gold"` for submit).
- Busy states (e.g., loading spinner) are present in Ask Joe.

## Gaps observed
- Mix of raw `<button>` and design-system `<Button>` in the same screens can create inconsistent sizing, focus states, and keyboard affordances.
- Multiple visual styles for secondary actions (outline, underline text, icon-only hover actions) make “safe to click” vs “destructive / irreversible” less obvious.
- Some contextual row actions are hidden until hover (great for density), but this can reduce discoverability for new recruiters.

## Suggestions
1. **Standardize action tiers**
   - Tier 1 (Primary): solid fill (single CTA per section)
   - Tier 2 (Secondary): outline/ghost
   - Tier 3 (Tertiary): text link
   - Destructive: explicit destructive variant + confirmation

2. **Adopt a button audit matrix**
   - Track label, variant, icon usage, keyboard behavior, loading state, disabled rule, and confirmation pattern.

3. **Promote consistent loading semantics**
   - Every networked action should disable during submit and swap to spinner + progress text (e.g., “Saving…”, “Enrolling…”).

---

## 2) Workflow Structure Audit

## Ask Joe flow
### What’s strong
- Clean single-thread chat interaction.
- Helpful starter prompt suggestions reduce blank-state friction.
- Mode switch between candidate/contact search is fast.

### Risks
- Mode switch appears as equal-weight pills; users may not notice context switch implications.
- “Ask Joe” CTA competes with being both command submit and broader product concept.

### Suggestions
- Add sublabel under input: **“Searching: Candidates”** or **“Searching: Contacts”** with color/status chip.
- Rename submit label dynamically to context-specific verbs:
  - “Search Candidates” / “Search Contacts” while preserving Ask Joe branding in title.
- Add one-click “Create workflow from results” affordances (e.g., enroll to sequence, shortlist, assign owner).

## Sequence Builder flow
### What’s strong
- Setup → Flow → Review tab model is recruiter-friendly.
- Save/activate distinction exists.
- AI draft generation tied to step context is high leverage.

### Risks
- Structural changes and their downstream effects (re-pace / schedule impact) may be hard to parse quickly.
- Workflow confidence depends on visibility of “what changed” before activation.

### Suggestions
- Add a persistent **Impact Panel** in Review:
  - “X steps changed”
  - “Y queued sends will be re-paced”
  - “Activation affects Z enrolled contacts/candidates”
- Add explicit post-action toasts with next-step CTA:
  - “Sequence activated. View schedule”
  - “Draft saved. Continue editing”

## List pages (Candidates/Contacts/Index)
### What’s strong
- Bulk selection with sequence enrollment supports recruiter throughput.
- Quick-access Ask Joe entry points are present.

### Risks
- Top-level actions can feel crowded when filters + Ask Joe + enroll + add actions coexist.
- Hover-only row actions reduce first-time discoverability.

### Suggestions
- Reserve top-right for max 1 primary + 1 AI + overflow menu.
- Add “More actions” kebab for lower-frequency actions.
- Keep 1-2 high-value row actions always visible on desktop; move the rest to row menu.

---

## 3) Information Architecture Improvements

1. **Define workflow nouns and verbs**
   - Nouns: Candidate, Contact, Sequence, Job, Search Session.
   - Verbs: Find, Qualify, Enroll, Send, Review, Assign.
   - Use these consistently in button labels.

2. **Clarify AI role in each screen**
   - AI for discovery (Ask Joe), AI for drafting (Sequence step copy), AI for recommendation (next best action).
   - Keep these distinct to avoid user confusion.

3. **Make irreversible actions unmistakable**
   - Delete/clear/merge actions should always show confirm dialog and short consequence text.

---

## 4) Quick Wins (1–2 sprints)

1. Build a `workflowActionSpec` doc and normalize top 20 most-used buttons.
2. Add standardized loading/disabled behavior to all async CTAs.
3. Add contextual subtitle chip on Ask Joe indicating active search domain.
4. Add “Impact Panel” to sequence review/activate experience.
5. Reduce top-bar button clutter on list pages by moving lower-priority actions into overflow.

---

## 5) Suggested UX KPI Tracking

- Time-to-first-qualified-candidate from Ask Joe query.
- Sequence activation success rate without edit rollback.
- Bulk action completion rate on list pages.
- Misclick rate on destructive actions.
- Median clicks from search result → enrollment.

If these KPIs improve, the UI changes are likely increasing recruiter throughput and confidence.
