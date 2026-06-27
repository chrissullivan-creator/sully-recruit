# Sully Recruit — Frontend Skill

## Stack
- React 18 + TypeScript + Vite
- shadcn/ui components
- Tailwind CSS — **LIGHT theme** (white canvas / sage neutrals, since the 2026-06-26 refresh; a `.dark` block still exists but `:root` is light)
- TanStack Query (react-query) for data fetching
- React Router for navigation
- sonner for toasts
- date-fns for formatting
- Deployed on Vercel — push to `main` = auto-deploy

---

## Unified Person Model (Pass 5a, 2026-05-03)

**Frontend code can keep using `from('contacts')` — it now hits a backwards-compat view, not a real table.** The view + INSTEAD OF triggers redirect reads/writes to `candidates WHERE type='client'`. New code should prefer:

```ts
// Preferred for clients
supabase.from('candidates').select(...).eq('type', 'client')
supabase.from('candidates').insert({ type: 'client', ... })

// Still works (via view + INSTEAD OF triggers, slightly slower)
supabase.from('contacts').select(...)
supabase.from('contacts').insert({ ... })  // type='client' set by trigger
```

**Update (Pass 6, 2026-05-03):** `people` is now the real **base table**;
`candidates` and `contacts` are views over it. New code can (and the
detail pages do) write to `from('people')` directly — e.g. `useCandidate`
reads `from('people').select('*')`. The `candidates`/`contacts` examples
above still work via the views. See SKILL-architecture.md for the canonical
column list and the `personal_email`/`work_email` rules.

The legacy `candidate_profiles`, `contact_profiles`, `person_*` tables/types are GONE — those were dropped. Don't import them.

**Dashboard date range:** `useDashboardMetrics(range)` requires a `{ from: Date, to: Date }` arg. Use `<DateRangePicker>` from `components/dashboard/DateRangePicker.tsx` with `defaultDashboardRange()` for the initial value.

---

## Custom Fields layer (2026-06-14)

Admin-defined, config-driven fields — add a field from the UI, no migration.
Definitions live in `custom_field_defs`; values live in a `custom_fields` JSONB
column on the base table (pilot: `people` only — companies/jobs get their own
column on rollout). `useCandidate` reads `people.*`, so a candidate's
`custom_fields` rides along with the record — **no view changes needed**.

- **Hook:** `useCustomFieldDefs(entityType, includeInactive?)` in `useData.ts`
  (`'candidate' | 'client' | 'company' | 'job'`). Active-only by default,
  cached 5 min.
- **Record editor:** `components/custom-fields/CustomFieldsSection.tsx` —
  self-saving (`UPDATE people SET custom_fields`), renders nothing when no
  fields are defined. Lives in the CandidateDetail **Background** tab.
- **Admin CRUD:** `components/custom-fields/CustomFieldsManager.tsx` at
  **Settings → Custom Fields** (admin-only). The live record editor is wired
  for **candidates** only so far.
- **Gotchas:** `key` is immutable (only `label` is renamable); `required` is a
  UI hint, not DB-enforced; value-type validation is UI-side (no DB trigger —
  `people` has too many writers). `custom_field_defs` isn't in the generated
  Supabase types, so cast the table arg: `supabase.from('custom_field_defs' as any)`.
- Promote a field to a real typed column the moment the engine/financials/
  reporting depend on it. Custom fields are for the long tail.

## Navigation — Data Hygiene moved (2026-06-14)

**Duplicates** (`/duplicates`) and **Collisions** (`/admin/collisions`) are no
longer in the sidebar (`components/layout/Sidebar.tsx`). They live under
**Settings → Data Hygiene** as launcher cards. The routes stay registered in
`App.tsx` for deep links — don't re-add them to the sidebar.

---

## Entity links — make every mention clickable (2026-06-23)

`components/shared/EntityLinks.tsx` is the **one** way to render a clickable
candidate / client contact / company / job anywhere in the app. Always prefer
these over re-inlining `navigate()`/`<Link>` so coverage stays consistent
site-wide.

- **`<PersonLink id name type? sourceTable? roles? stopPropagation? />`** —
  routes to `/candidates/:id` (candidate) or `/contacts/:id` (client). Decides
  from `type==='client'` / `sourceTable==='contact'` / `roles`; dual-role →
  candidate page. No `id` → renders plain text (never a dead link).
- **`<JobLink id title? stopPropagation? />`** — `/jobs/:id`.
- **`<CompanyLink companyId? name? showLogo? domain? logoUrl? stopPropagation? />`**
  — `/companies/:id`. Resolves the id from `companyId` **or**, when only a name
  string is available, from `useCompanyNameIndex()` (a cached
  normalized-name→id map over `companies` + `company_aliases`, mirroring the
  DB's `normalize_company_name()`; lazily loaded only when some link lacks an
  id). `showLogo` renders `<CompanyLogo>` inline. Falls back to plain text when
  the name can't be resolved.
- **`stopPropagation`** — pass when the link sits inside a clickable row/card so
  the parent's `onClick` (e.g. "open candidate") doesn't also fire. The link
  uses a real `<a>` so cmd/middle-click opens a new tab.
- ⚠️ Don't nest these inside a `<button>` (invalid HTML). If a row is a
  `<button>`, convert it to a `<div role="button" tabIndex={0} onKeyDown=…>`
  first (see the dashboard `SendOutRow`/`CandidateRow` in `Index.tsx`).
- ⚠️ Don't add a link where the row's click is an **action** (e.g. "add to
  send-outs" pickers) rather than navigation — it would hijack the action.

---

## Proactive & Agentic Joe UI (2026-06-21)

- **`/today`** (`pages/Today.tsx`, sidebar item "Today", `Sun` icon) — the
  proactive "Today / For You" feed. Reads `joe_briefings` for the current
  `useAuth().user.id` (`from('joe_briefings' as any)`), grouped by `category`,
  ordered by `score`. Each card links to the entity and has done/snooze/dismiss
  (status updates only — read-only surface). Shows an empty state until the
  `joe-daily-brief` cron populates it (gated by `JOE_PROACTIVE_ENABLED`).
- **`JoeActionCard`** (`components/joe/JoeActionCard.tsx`) — renders the
  approve/edit/reject proposal cards Ask Joe emits via the `data:{"action":{…}}`
  SSE event (only when `JOE_AGENTIC_ENABLED` is on). `add_note` executes inline
  (safe `notes` insert); consequential actions (draft/enroll/move/task)
  deep-link to the proper UI via `action.route` to confirm — Joe never
  sends/moves on its own. Wired into `AskJoe.tsx`'s SSE loop (`setActions`).
- The new tables aren't in generated Supabase types — cast `as any`.

---

## New surfaces — week of 2026-06-27

### Ask Joe everywhere (global launcher)
`components/joe/AskJoeLauncher.tsx` (+ `AskJoePanel.tsx`) mounts in
`layout/MainLayout.tsx` → a command-palette launcher on **every page**, opened
with **⌘/Ctrl-J** (Esc closes). Streams from `ask-joe`. Replaced the old floating
`AskJoeButton`. See SKILL-joe.md.

### Dashboard — AI Command Center hero
`components/dashboard/CommandCenter.tsx`, rendered at the top of
`pages/Index.tsx` (replaced the welcome banner; legacy funnel/lists/calendar
remain below as "Pipeline detail"). A KPI strip (Calls Today, Interviews 7d,
Offers Out, Placements MTD, Open Searches, Avg Time-to-Fill) + AI "signal" cards
(Ready to Move, Follow-ups Due, Below Market, Searches at Risk, Ask-Joe-says,
Revenue). One round-trip via the `command_center_summary()` RPC →
`hooks/useCommandCenter.ts`. Rows carry person avatars / company logos.

### Jobs — two boards
`pages/Jobs.tsx` `view: 'leads' | 'jobs' | 'list'` (default `'jobs'`).
- **Leads board** (`status==='lead'`): **draggable** kanban over `jobs.lead_stage`
  (`LEAD_STAGES` from `@/lib/jobStatus`: New → Contacts Added → Reached Out →
  Market Over); drop persists `lead_stage` optimistically.
- **Hot Jobs board** (non-lead, non-closed): **read-only** — each job sits in the
  column of its **furthest-along candidate** (`useJobPipelineStages()` unions
  `candidate_jobs` + `send_outs`); a "Sourcing" bucket leads `PROGRESSION` from
  `@/lib/pipeline`. You move a job by moving its candidates.
- Both render via generic `components/pipeline/JobStageBoard.tsx` (draggable only
  when an `onMove` is supplied).

### Interviews (Planner)
`pages/Interviews.tsx` at `/interviews` under the Planner sub-nav
(`Calendar | To-Do's | Interviews`); deep-link `?interview=<id>`. Groups
Upcoming / To-be-scheduled / Completed. Detail slide-over
`components/interviews/InterviewDetail.tsx` (schedule, type/round, interviewers
people-picker, prep notes, **Debrief panel** with the recorded call);
`NewInterviewDialog.tsx`. **Multiple rounds = one row per round**
(`lib/createInterview.ts` auto-increments `interviews.round`); auto-created from
send-outs via `lib/interviewWorkflow.ts`. Constraint values + calendar drop:
SKILL-architecture.md. "New Interview" buttons on the page and on each send-out
row (`CandidateRow.tsx`).

### Send Out → Submission flow
`pages/SendOut.tsx` (`/candidates/:id/sendout`), steps **choose → formatting →
preview → email**. Entry: "Ask Joe — format & submit" in
`components/candidate/CandidateDrawer.tsx`. In-app **server-side résumé formatter**
`/api/format-resume-ai` (Emerald-house HTML, `gpt-5.4`) → PDF client-side
(`html2canvas` + `jsPDF`, added to package.json) → Tiptap email composer →
send-now or schedule (`/api/send-sendout` → `scheduled_messages` + Inngest
`send-message-scheduled`). "Notes for Joe" modify loop accumulates feedback and
re-formats from the source résumé each time. `OfferDialog.tsx` for offers. This
is the in-app sibling of the ChatGPT path in `claude/GPT-SENDOUT-ACTION.md`.

### Inbox / Communication Hub overhaul
`pages/Inbox.tsx` (+ `components/inbox/*`):
- **New "All" tab is the DEFAULT** (`?tab=all|focused|other`) — unions
  focused (linked) + other (unlinked) + live unknown-sender Unipile threads.
  Sidebar gains an "All" row. (The old focused/other-only world is stale.)
- `inbox_threads` view now exposes `sender_name` + `avatar_url`; **`ThreadAvatar`**
  (photo → initials → channel glyph). Display fallback
  `candidate_name || contact_name || sender_name` so unlinked InMails show the
  real sender.
- **Inbox "Add"** (`AddPersonWizard.tsx`) does fuzzy match → **update-or-create**
  ("Connect & Update" overwrites with newest, links the conversation): endpoints
  `/api/search-person`, `/api/update-person`, shared `api/lib/fuzzy-match-person.ts`.
- **Bulk Reconcile** (`ReconcileUnknownDialog.tsx`, Sparkles/Martini button on
  Other/All) → `/api/inbox/reconcile-unknown` (scan/apply, **link-only**).
- Calls panel gains a newest/oldest sort toggle; `invalidate.ts` `COMMS_KEYS`
  now includes `inbox_live_threads` (refresh-on-link).

### Picklist multi-selects (#370)
`components/shared/PicklistMultiSelect.tsx` (+ `PicklistEditSection.tsx`), backed
by `usePicklist(category)`; admin CRUD at **Settings → Option Lists**
(`components/settings/OptionListsSection.tsx`). Drives Department + Products on
candidate/contact/job; company Industry (+ Strategy, shown only for Hedge Funds).
Schema/columns: SKILL-architecture.md. Because `contacts` is a view lacking the
new array columns, ContactDetail reads/writes `departments`/`products` on the
underlying `people` row.

### Import from LinkedIn Recruiter
`pages/LinkedInRecruiterImport.tsx` at `/admin/linkedin-recruiter-import` (card
in Settings → Import): paste a Recruiter search/pipeline URL → seat picker →
`/api/linkedin-recruiter-search` (v2, read-only) → preview table → fuzzy-dedup
review (`components/import/ImportMatchReviewDialog.tsx` ← `/api/match-people`) →
CSV export (`lib/csvExport.ts`) or import via `/api/add-person`.

### Source pipeline — in-Sully actions (#383)
`pages/SourceProject.tsx`: each (read-only LinkedIn pipeline) row gets a
DropdownMenu — Enroll in sequence (`EnrollInSequenceDialog`), Create send-out,
Open & message, Remove from pipeline.

---

## ⚠️ Vite Env Vars — CRITICAL

Only `VITE_` prefixed vars work. `REACT_APP_*` is ALWAYS undefined.

```ts
// CORRECT
import.meta.env.VITE_SUPABASE_URL
import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

// BROKEN — always empty string
import.meta.env.REACT_APP_BACKEND_URL  // ❌ never use
```

---

## Design System (Premium Fintech refresh — 2026-06-26)

The app flipped from dark to a **light, white-canvas / white-sidebar** look. All
tokens are HSL triplets in **`frontend/src/index.css`** (`:root`). Neutrals were
retinted from cool grey to a low-saturation **sage** family (hue ~146–150°) while
holding lightness so AA contrast is unchanged; **cards/popovers stay pure white**
to pop against the sage shell.

### Colors (current `:root` tokens)
```css
--background: 146 16% 97%    /* soft sage shell */
--foreground: 150 12% 13%    /* near-black, faint sage tint */
--card / --popover: 0 0% 100%/* PURE WHITE */
--primary: 152 76% 18%       /* emerald #0B4F2F — primary actions, active pill */
--accent:  46 68% 47%        /* gold #C9A227 — used sparingly */
--secondary / --muted: ~146 14-16% 95%   /* sage fills */
--border / --input: 146 13% 90%          /* sage border */
--ring: 152 76% 18%          /* emerald focus */
--radius: 0.875rem           /* 14px cards */
--success 152 55% 30% · --warning 46 68% 47% · --info 199 89% 40%
/* sidebar is near-white sage now: --sidebar-background 146 16% 98%, --sidebar-primary 152 76% 18% (emerald active pill) */
/* hex spec tokens also exported: --emerald #0B4F2F, --gold #C9A227, --page-bg #F4F9F6, --card-border #E0E9E4 */
```
Fonts: `--font-sans 'Inter'`, `--font-display 'Sora'`, `--font-mono 'JetBrains Mono'`.
⚠️ The old dark-theme `--accent: #2A5C42` / `--gold: #C9A84C` are gone. `thead.table-header-green` is kept by name but is now a muted (not dark-green) bar.

### Brand mark & avatars
- **Brand/Joe icon = lucide `Martini`** (replaced `Sparkles` everywhere, #380). Sidebar "E" mark recolors the gold logo to emerald via a CSS mask (`Sidebar.tsx`).
- **`components/shared/PersonAvatar.tsx`** — profile image (`profile_picture_url` → `avatar_url`) → initials chip (`bg-primary/10 text-primary`); `onError` flips to initials.
- **`components/shared/CompanyLogo.tsx`** — `companies.logo_url` → **Clearbit** (`logo.clearbit.com/{domain}`) → initials.
- **`lib/recruiterAvatars.ts`** — `recruiterAvatar(email)` maps Chris/Nancy emails to bundled photos (`assets/recruiters/`), else initials. Used in sidebar, dashboard + send-out user filters.

### Component Variants (Button)
```tsx
<Button variant="gold">Primary action</Button>
<Button variant="gold-outline">Secondary</Button>
<Button variant="outline">Tertiary</Button>
<Button variant="ghost">Minimal</Button>
<Button variant="destructive">Delete/danger</Button>
```

### Status Badge Colors
```ts
// Candidate / client status enum (post Pass 5a — same enum for both types)
new:         'bg-blue-500/10 text-blue-400'
reached_out: 'bg-yellow-500/10 text-yellow-400'
engaged:     'bg-success/10 text-success'

// Old status values back_of_resume, placed, dnc, stale, active are NO LONGER VALID.
// The CHECK constraint will reject them.
// `back_of_resume` is now a BOOLEAN column (filter checkbox), not a status badge.

// Sentiment colors
interested:     emerald green
positive:       green
maybe:          gold/amber
neutral:        gray
negative:       orange
not_interested: red
do_not_contact: dark red
```

---

## Key Component Locations

```
frontend/src/
  pages/
    Index.tsx               dashboard (route '/')
    People.tsx              unified people list (candidates + clients)
    Candidates.tsx          candidate list + resume drop
    CandidateDetail.tsx     candidate profile + tabs (custom fields in Background tab)
    Contacts.tsx / ContactDetail.tsx   client list + profile
    Companies.tsx / CompanyDetail.tsx
    Jobs.tsx / JobDetail.tsx           Leads board + Hot Jobs board + list
    Interviews.tsx          Planner → Interviews (list + detail slide-over)
    SendOut.tsx             /candidates/:id/sendout — format & submit flow
    Today.tsx               proactive Joe "Today" feed
    SourceProject.tsx       LinkedIn Recruiter pipeline (read-only + in-Sully actions)
    LinkedInRecruiterImport.tsx   /admin/linkedin-recruiter-import
    Sequences.tsx           sequence list
    SequenceBuilder.tsx     node-based sequence builder (/sequences/new, /:id/edit)
    SequenceScheduleView.tsx / SequenceAnalyticsPage.tsx
    Inbox.tsx               unified Communication Hub (Calls live here via ?section=calls)
    DuplicatesReview.tsx / CollisionReview.tsx   reached via Settings → Data Hygiene
    Settings.tsx            tabbed settings
  components/
    sequences/
      FlowBuilder.tsx       node graph builder
      StepEditorDialog.tsx  per-action step editor
      SequenceStepCard.tsx / SequenceReview.tsx / SequenceSetup.tsx / SequenceList.tsx
      ChannelLimitsSettings.tsx   Settings → Send Limits
    custom-fields/
      CustomFieldsSection.tsx     record-page editor (self-saving)
      CustomFieldsManager.tsx     Settings → Custom Fields admin CRUD
    candidates/
      EnrollInSequenceDialog.tsx
    shared/
      ResumeDropZone.tsx    resume upload + parse
    layout/
      MainLayout.tsx / PageHeader.tsx / Sidebar.tsx
  hooks/
    useData.ts              useCandidate, useCandidates, useJobs, useCustomFieldDefs, etc.
    useProfiles.ts          team member profiles
  integrations/
    supabase/client.ts      supabase client singleton
```

---

## Data Fetching Pattern

```tsx
// Always use existing hooks from useData.ts
const { data: candidate, isLoading } = useCandidate(id);
const { data: candidates = [] } = useCandidates();
const { data: jobs = [] } = useJobs();

// Custom query
const { data } = useQuery({
  queryKey: ['some_key', id],
  enabled: !!id,
  queryFn: async () => {
    const { data, error } = await supabase
      .from('table_name')
      .select('*')
      .eq('id', id);
    if (error) throw error;
    return data;
  },
});

// Invalidate after mutation
queryClient.invalidateQueries({ queryKey: ['candidate', id] });
```

---

## Supabase Client Pattern

```tsx
import { supabase } from '@/integrations/supabase/client';

// Direct DB operation
const { error } = await supabase
  .from('candidates')
  .update({ current_title: value })
  .eq('id', id);

// Edge function call
const { data: { session } } = await supabase.auth.getSession();
const resp = await fetch(
  `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/FUNCTION_NAME`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ... }),
  }
);
```

---

## Resume Drop Zone Flow

1. User drops file → `uploadFile()` → Supabase Storage `resumes` bucket
2. Call `process-resume` with `{ file_path, file_name }`
3. Response: `{ success: true, candidate_id, parsed: { first_name, last_name, email, phone, current_title, current_company, location, linkedin_url } }`
4. Map `location` → show in "Location" field (saves to `location_text` in DB)
5. Show review form pre-filled
6. On save → UPDATE only (process-resume already created the record)
7. Voyage embedding fires automatically in process-resume

**⚠️ Do NOT insert a second time. process-resume already saved the candidate.**
**⚠️ The correct endpoint is `process-resume` NOT `parse-resume` (doesn't exist)**

---

## Sequence Step Composer — Ask Joe

The sequence builder is now node-based: `FlowBuilder.tsx` + the per-action
`StepEditorDialog.tsx` (the old `campaigns/CampaignStepItem.tsx` is gone). Any
`ask-joe` drafting call (`draft_message` mode) must pass the context below —
see SKILL-joe.md for the canonical drafting contract:
- `job_id` (not just jobTitle string) → Joe calls `get_job_context` to read full spec
- `sequenceDescription` → Joe understands the campaign context
- `channel` → Joe writes appropriate length/tone
- `step_number` + `total_steps` → Joe knows if it's a breakup email (final step)
- `sender` → Joe uses correct signature

---

## Inbox Chat Bubble UI

Messages display iMessage-style:
- Outbound (direction = 'outbound') → right-aligned, accent/green background
- Inbound (direction = 'inbound') → left-aligned, secondary background
- Grouped by sender — avatar only on first in group
- Date dividers between days
- Strip quoted email history from body (everything after "On [date]... wrote:")
- Reply composer at bottom with channel-specific placeholder

---

## Common Patterns

### Editable Field
```tsx
// Pattern used throughout CandidateDetail sidebar
const [editing, setEditing] = useState(false);
// Click to edit → input appears → Enter/Save → blur → back to display
```

### Toast Notifications
```tsx
import { toast } from 'sonner';
toast.success('Saved');
toast.error('Failed to save');
toast.info('Loading...');
```

### Loading State
```tsx
{isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
```

### No Forms — Use onClick handlers
```tsx
// ⚠️ Never use HTML <form> tags — use onClick/onChange handlers only
<Button onClick={handleSubmit}>Save</Button>
```
