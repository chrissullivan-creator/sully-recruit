# Sully Recruit — Frontend Skill

## Stack
- React 18 + TypeScript + Vite
- shadcn/ui components
- Tailwind CSS (dark theme)
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

## Design System

### Colors (Emerald Brand)
```css
--accent: #2A5C42       /* Emerald green — primary actions, headers */
--gold: #C9A84C         /* Gold — secondary actions, highlights */
```

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
    Jobs.tsx / JobDetail.tsx           jobs list + pipeline
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
