# Ask Joe Send Outs Emerald — GPT Action setup

This is the setup guide for the **"Ask Joe Send Outs Emerald"** ChatGPT
Custom GPT Action. It hooks the GPT into your existing Sully Recruit
Supabase database via a new set of endpoints under `/api/gpt/*` in the
same Vercel project that already hosts the recruiter app.

**Why integrate instead of a separate project?**
- You already have `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in
  Vercel for the recruiter app — these endpoints reuse them.
- `@supabase/supabase-js` and `@vercel/node` are already dependencies.
- One deploy, one URL, one set of logs.

## Files added

```
frontend/api/lib/gpt-auth.ts            ← Bearer ASK_JOE_SENDOUT auth (env var)
frontend/api/gpt/candidates.ts          ← GET /api/gpt/candidates
frontend/api/gpt/jobs.ts                ← GET /api/gpt/jobs
frontend/api/gpt/submission-context.ts  ← GET /api/gpt/submission-context
frontend/api/gpt/submissions.ts         ← POST /api/gpt/submissions
openapi.yaml                            ← Paste into the GPT Action config
```

## How the existing schema is reused (no new tables)

| GPT concept           | Live table / view used                                              |
| --------------------- | ------------------------------------------------------------------- |
| candidates            | `candidates` (view over `people` where `type='candidate'`)          |
| jobs                  | `jobs` (note: column is `title` not `job_title`, `description` not `job_spec`) |
| recruiter notes       | `notes` (polymorphic by `entity_type='candidate'`, `entity_id=…`)   |
| Ask Joe / call notes  | `ai_call_notes` (328 rows of transcripts + AI summaries)            |
| resume text           | `resumes.raw_text` + `resumes.ai_summary`                           |
| submissions           | `submissions` (existing — needs a small extension, see below)       |

## ⚠️ One-time Supabase migration

The existing `submissions` table doesn't yet have columns for
status / tags / write-up / formatted resume URL, and there's no unique
constraint on `(candidate_id, job_id)`. Run this **once** in the
Supabase SQL editor (or via `supabase db push`):

```sql
-- Extend submissions for GPT workflow. All columns are nullable so
-- existing rows are unaffected.
ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS status               text DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS tags                 text[] DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS submission_writeup   text,
  ADD COLUMN IF NOT EXISTS formatted_resume_url text,
  ADD COLUMN IF NOT EXISTS submitted_by_label   text;

-- Keep statuses on-spec.
ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_status_check;
ALTER TABLE public.submissions
  ADD  CONSTRAINT submissions_status_check
       CHECK (status IS NULL OR status IN (
         'draft','ready_to_submit','submitted','client_review',
         'interview','rejected','withdrawn','placed'
       ));

-- One submission per candidate↔job pair (safe to add: table currently 0 rows).
ALTER TABLE public.submissions
  DROP CONSTRAINT IF EXISTS submissions_candidate_job_unique;
ALTER TABLE public.submissions
  ADD  CONSTRAINT submissions_candidate_job_unique UNIQUE (candidate_id, job_id);
```

The API does a manual lookup-then-insert/update, so it will still work
without the unique constraint — but the constraint is your safety net
against duplicate submissions if anything ever calls the upsert in
parallel.

## What you need to do on Vercel

You already have the project deployed. The **only** new thing is one
environment variable:

| Key                         | Where to set                | Value                                            |
| --------------------------- | --------------------------- | ------------------------------------------------ |
| `ASK_JOE_SENDOUT`           | Vercel → Project → Settings → Environment Variables | A long random string (e.g. `openssl rand -hex 32`). This is the bearer token your GPT will send. |
| `SUPABASE_URL`              | Already set ✅              | (no change)                                      |
| `SUPABASE_SERVICE_ROLE_KEY` | Already set ✅              | (no change)                                      |

Apply to **Production, Preview, and Development** scopes. Then
**redeploy** (or push to `main` to trigger an auto-deploy) so the new
env var is loaded into the running functions.

```bash
# Generate a key locally if you want:
openssl rand -hex 32
```

## How to test the endpoints with curl

Replace `$VERCEL_URL` with your deployment URL and `$KEY` with the
value you set for `ASK_JOE_SENDOUT`.

```bash
# 1) Search candidates by name
curl -H "Authorization: Bearer $KEY" \
  "$VERCEL_URL/api/gpt/candidates?name=Pururav"

# 2) Search candidates by keyword
curl -H "Authorization: Bearer $KEY" \
  "$VERCEL_URL/api/gpt/candidates?keyword=macro%20quant"

# 3) Search jobs
curl -H "Authorization: Bearer $KEY" \
  "$VERCEL_URL/api/gpt/jobs?company=Schonfeld"

# 4) Pull full submission context (use real UUIDs from steps 1 & 3)
curl -H "Authorization: Bearer $KEY" \
  "$VERCEL_URL/api/gpt/submission-context?candidate_id=…&job_id=…"

# 5) Create / update a submission
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_id": "…",
    "job_id": "…",
    "status": "ready_to_submit",
    "tags": ["macro_quant_research", "systematic_fixed_income"],
    "submission_writeup": "Pururav is a strong fit for…",
    "submitted_by": "Ask Joe Send Outs Emerald"
  }' \
  "$VERCEL_URL/api/gpt/submissions"

# 6) Mark it submitted later
curl -X POST -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_id": "…",
    "job_id": "…",
    "status": "submitted",
    "mark_submitted": true
  }' \
  "$VERCEL_URL/api/gpt/submissions"
```

A 401 means `ASK_JOE_SENDOUT` isn't set in Vercel (or your curl token
is wrong). A 500 with `column "status" does not exist` means the
migration above hasn't been applied yet.

## How to wire up the ChatGPT Custom GPT

1. Open the GPT editor for **"Ask Joe Send Outs Emerald"** → **Configure**.
2. Scroll to **Actions** → **Create new action**.
3. **Authentication** → **API Key**:
   - Auth Type: **Bearer**
   - API Key: paste the same value you set for `ASK_JOE_SENDOUT` in Vercel.
4. **Schema**: open `openapi.yaml` from this repo, change the `servers:`
   url to your actual Vercel deployment URL (e.g.
   `https://sully-recruit.vercel.app`), and paste the whole file in.
5. **Privacy policy URL**: any URL is fine for internal use.
6. Save.

## GPT Instructions block (paste into the GPT's instructions field)

> When the user asks to format a candidate for a job, search candidates
> and jobs through the Emerald Recruiting Supabase API when candidate
> names, company names, or role titles are provided. Pull candidate
> resume text, call notes, recruiter notes, job spec, product coverage,
> systems, compensation notes, and submission context. Use Supabase
> notes as approved source material, but never invent experience. Use
> the job spec to tailor the resume and write-up. After producing the
> resume and write-up, if the user asks to submit, tag, attach, mark,
> or save the candidate to the role, call `createOrUpdateSubmission`.
> Save the submission write-up, status, tags, and formatted resume URL
> when available. Do not edit core candidate or job records.

## Example natural-language workflows

- "Find Pururav and the Schonfeld macro quant research role."
  → `searchCandidates(name=Pururav)` + `searchJobs(company=Schonfeld, title=macro quant)`
- "Format Pururav for Schonfeld and do the write-up."
  → `getSubmissionContext(candidate_id, job_id)` → draft resume + write-up.
- "Tag Pururav to the Schonfeld macro quant role as ready_to_submit."
  → `createOrUpdateSubmission({candidate_id, job_id, status: "ready_to_submit", tags: […]})`
- "Mark him submitted and save the write-up."
  → `createOrUpdateSubmission({candidate_id, job_id, status: "submitted", mark_submitted: true, submission_writeup: "…"})`
- "Pull candidate notes and job spec before tailoring."
  → `getSubmissionContext(candidate_id, job_id)`

## Security notes

- `SUPABASE_SERVICE_ROLE_KEY` never leaves Vercel — only `ASK_JOE_SENDOUT`
  is shared with the GPT.
- Endpoints are **read-only** for candidates, jobs, and notes — there
  is no destructive endpoint and no edit endpoint for core records.
- The only write is **upsert on `submissions`** (and the status check
  constraint blocks anything off-script).
- Rotate `ASK_JOE_SENDOUT` whenever you want — just update Vercel +
  the GPT Action config and redeploy.
