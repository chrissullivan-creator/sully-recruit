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

The `Tables<'people'>`, `Tables<'candidate_profiles'>`, `Tables<'contact_profiles'>`, `Tables<'person_*'>` types are GONE — those tables were dropped. Don't import them.

**Dashboard date range:** `useDashboardMetrics(range)` requires a `{ from: Date, to: Date }` arg. Use `<DateRangePicker>` from `components/dashboard/DateRangePicker.tsx` with `defaultDashboardRange()` for the initial value.

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
    Candidates.tsx          candidate list + resume drop
    CandidateDetail.tsx     candidate profile + tabs
    Contacts.tsx            contacts list
    ContactDetail.tsx       contact profile
    Jobs.tsx                jobs list
    JobDetail.tsx           job + pipeline
    Sequences.tsx           sequence list
    SequenceDetail.tsx      sequence builder + enrollees + analytics
    Inbox.tsx               unified inbox
    Dashboard.tsx           dashboard
  components/
    campaigns/
      CampaignStepItem.tsx  sequence step editor (Ask Joe button here)
      CampaignBuilder.tsx   sequence step list
      SequenceAnalytics.tsx general tab analytics
    candidates/
      EnrollInSequenceDialog.tsx
      AddCandidateDialog.tsx
    shared/
      ResumeDropZone.tsx    resume upload + parse
    layout/
      MainLayout.tsx
      PageHeader.tsx
    tasks/
      TaskSidebar.tsx
  hooks/
    useData.ts              useCandidate, useCandidates, useJobs, etc.
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

Ask Joe button in `CampaignStepItem.tsx` calls `ask-joe` edge function in `draft_message` mode.

Must pass:
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
