# Ask Joe Send-Out — Custom GPT Action wiring

End-to-end setup for the ChatGPT custom GPT that drafts a branded sendout
(blurb + reformatted resume) from a candidate + job pairing, tags the
job, and moves the candidate to **Submission** stage in Sully Recruit.

> **Update 2026-06-27 — there is now an IN-APP path too.** `pages/SendOut.tsx`
> (`/candidates/:id/sendout`) formats résumés **server-side** via
> `/api/format-resume-ai` (Emerald-house HTML, `gpt-5.4`) and renders the PDF
> **client-side** (`html2canvas` + `jsPDF`), then sends/schedules the client
> email (`/api/send-sendout`). So the note below that "Sully Recruit doesn't
> render PDFs server-side" is true only of *this ChatGPT path* — the app now has
> its own formatter/PDF/email flow. The two coexist; the ChatGPT custom-GPT
> wiring in this doc still works. See SKILL-frontend.md "Send Out → Submission flow".

## What the GPT does

The user says something like *"Format Jane Doe for the Goldman MD role"*.
The GPT then:

1. Calls `searchCandidateAndJob` with `candidate_query="Jane Doe"`,
   `job_query="Goldman MD"`. If multiple matches come back, it asks the
   user to disambiguate.
2. Calls `fetchSendoutContext` with the chosen `candidate_id` + `job_id`
   to pull the candidate profile, latest parsed resume, AI call-notes,
   manual notes, and the job description.
3. Drafts the intro blurb and a reformatted, role-tailored resume
   inside ChatGPT (rendering the branded PDF via ChatGPT's code
   interpreter — Sully Recruit doesn't render PDFs server-side).
4. After the user approves, calls `saveFormattedSendout` to:
   - persist the text-form resume + blurb in Sully Recruit
   - create or advance the `send_outs` row for this candidate + job
   - move the stage to **Submission** (`submitted`) and stamp
     `sent_to_client_at`.

## Backend pieces (already in this branch)

- Migration **`20260522020000_gpt_action_fields.sql`** — adds
  `formatted_resumes.content_text` and `send_outs.submission_blurb`.
- **`POST /api/gpt/search-candidate-and-job`** — fuzzy match.
- **`POST /api/gpt/fetch-sendout-context`** — context bundle.
- **`POST /api/gpt/save-formatted-sendout`** — write-back + stage move.

All three live under `frontend/api/gpt/` and use the shared
`requireAuth` helper. Auth = `Authorization: Bearer <token>` where
`<token>` is either the Supabase service-role key (what the GPT uses)
or a logged-in user JWT.

## Setup checklist

### 1. Apply the migration

Either via Supabase dashboard → SQL editor (paste the file contents
and run), or via `supabase db push` if you have the CLI configured.
Migration is idempotent (`IF NOT EXISTS`).

### 2. Deploy to Vercel

Push this branch to `main` (or merge a PR) and let Vercel auto-deploy.
The three new endpoints will be live at
`https://<your-vercel-domain>/api/gpt/...`.

No new env vars are required — the endpoints reuse `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, which are already set.

### 3. Get the bearer token

In the Supabase dashboard → **Project Settings → API**, copy the
`service_role` secret. This is the Bearer token the GPT will send on
every request. Treat it like a god-mode credential — anyone with the
GPT can use it.

### 4. Create / edit the custom GPT

Inside ChatGPT (your Emerald Team workspace):

1. **Configure → Instructions** — paste the GPT prompt below
   (Appendix A).
2. **Configure → Actions → Create new action**:
   - **Authentication:** API Key → **Auth Type: Bearer** → paste the
     Supabase `service_role` value.
   - **Schema:** paste the YAML below (Appendix B), replacing
     `YOUR_PRODUCTION_DOMAIN` with your Vercel production domain
     (recommended: set up a stable alias like
     `app.emeraldrecruit.com` so the schema doesn't break on each
     deploy).
   - **Privacy policy URL:** required only if you publish broadly —
     since this GPT is workspace-only, you can use the Emerald site
     privacy URL or skip if your workspace settings allow.
3. **Sharing:** set to **"Only people in my workspace"** so only
   Emerald team members can call it.

### 5. Smoke test

In the GPT, type *"What can you do?"* — it should describe its job.
Then *"Search for candidate John and the Citi VP role"* — the GPT
should call `searchCandidateAndJob` and return matches. If it fails:

- 401 / "Unauthorized" → bearer token is wrong or missing.
- 404 / "candidate not found" → IDs aren't from your DB; the GPT
  hallucinated. Re-prompt it to call search first.
- The endpoint URL goes 404 → the path in the schema doesn't match
  `/api/gpt/...`. Verify the Vercel domain in `servers.url`.

## Appendix A — GPT system instructions

Paste this into the GPT's Instructions panel.

```
You are the Emerald Recruiting Send-Out assistant. You help senior Wall
Street recruiters draft client-facing submission packages from a
candidate + job pairing already in Sully Recruit.

Workflow you must follow:

1. When the user names a candidate and a job in free text (e.g.,
   "Format Jane Doe for the Goldman MD role"), call
   searchCandidateAndJob first. NEVER guess or invent IDs.

2. If multiple candidates or jobs match, list the top matches with
   their current_title / current_company and ask the user to pick.

3. Once you have a single candidate_id + job_id, call
   fetchSendoutContext to pull the candidate profile, latest resume
   text, call notes, and job description.

4. Draft TWO outputs and show them to the user for review:
   (a) A 2-3 sentence candidate-intro blurb in the voice of a senior
       Wall Street recruiter at The Emerald Recruiting Group. Be
       concise, specific, and highlight the most relevant 2-3
       experience points for THIS role.
   (b) A reformatted resume in clean professional prose. Use the
       candidate's actual experience from latest_resume.raw_text and
       latest_resume.parsed_json — DO NOT invent companies, dates,
       titles, deals, products, or accomplishments. You may rephrase
       and reorder; you may NOT add facts that are not in the source.
       Surface metrics and deal experience when they appear. Tailor
       the framing to the job description without falsifying anything.

5. After producing the resume, also generate a branded PDF using your
   code interpreter — Emerald house style: serif headers, clean
   single-column layout, emerald-green section dividers, name + title
   in the header. Attach the PDF so the user can download it.

6. Only after the user explicitly approves the draft, call
   saveFormattedSendout with the final formatted_resume_text (the
   plain-text/markdown version) and the blurb. This writes the
   record back into Sully Recruit and moves the candidate to the
   Submission stage. Confirm to the user once it succeeds.

Hard rules:
- Never invent biographical, employment, or compensation facts. If
  something is missing from the context, leave it out or ask the user.
- Never call saveFormattedSendout before the user approves the draft.
- Compensation, target locations, and right-to-work info comes from
  the candidate record + call notes. Don't fabricate.
- The blurb addresses the hiring team, not the candidate.
- If fetchSendoutContext returns existing_send_out_stage in
  ["interview","offer","placed","withdrawn","placed"], warn the user
  before re-saving — they may be overwriting a later-stage record.
```

## Appendix B — OpenAPI schema for the GPT Action

Replace `YOUR_PRODUCTION_DOMAIN` with your Vercel domain.

```yaml
openapi: 3.1.0
info:
  title: Sully Recruit Send-Out
  description: Read candidate + job context from Sully Recruit and persist a formatted send-out.
  version: 1.0.0
servers:
  - url: https://YOUR_PRODUCTION_DOMAIN
paths:
  /api/gpt/search-candidate-and-job:
    post:
      operationId: searchCandidateAndJob
      summary: Fuzzy-match a candidate name and job title against Sully Recruit.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                candidate_query:
                  type: string
                  description: Free text — candidate name, current company, or partial.
                job_query:
                  type: string
                  description: Free text — job title, client company, or partial.
                limit:
                  type: integer
                  description: Max rows per side. Default 5, max 20.
      responses:
        "200":
          description: Matches.
          content:
            application/json:
              schema:
                type: object
                properties:
                  candidates:
                    type: array
                    items:
                      type: object
                      properties:
                        candidate_id: { type: string }
                        full_name: { type: string }
                        current_title: { type: string, nullable: true }
                        current_company: { type: string, nullable: true }
                        linkedin_url: { type: string, nullable: true }
                        status: { type: string, nullable: true }
                  jobs:
                    type: array
                    items:
                      type: object
                      properties:
                        job_id: { type: string }
                        title: { type: string }
                        company: { type: string, nullable: true }
                        location: { type: string, nullable: true }
                        stage: { type: string, nullable: true }
                        priority: { type: string, nullable: true }
                        hiring_manager: { type: string, nullable: true }

  /api/gpt/fetch-sendout-context:
    post:
      operationId: fetchSendoutContext
      summary: Pull candidate profile, latest resume text, call notes, and job description.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [candidate_id, job_id]
              properties:
                candidate_id: { type: string }
                job_id: { type: string }
      responses:
        "200":
          description: Bundled context.
          content:
            application/json:
              schema:
                type: object
                properties:
                  candidate: { type: object }
                  latest_resume:
                    type: object
                    nullable: true
                    properties:
                      resume_id: { type: string }
                      file_name: { type: string, nullable: true }
                      raw_text: { type: string, nullable: true }
                      ai_summary: { type: string, nullable: true }
                      parsed_json: { type: object, nullable: true }
                      created_at: { type: string }
                  ai_call_notes:
                    type: array
                    items: { type: object }
                  call_logs:
                    type: array
                    items: { type: object }
                  manual_notes:
                    type: array
                    items: { type: object }
                  job: { type: object }
                  existing_send_out_id: { type: string, nullable: true }
                  existing_send_out_stage: { type: string, nullable: true }

  /api/gpt/save-formatted-sendout:
    post:
      operationId: saveFormattedSendout
      summary: Persist the formatted resume + blurb and move the send-out to Submission.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [candidate_id, job_id, formatted_resume_text, blurb]
              properties:
                candidate_id: { type: string }
                job_id: { type: string }
                formatted_resume_text:
                  type: string
                  description: Plain-text or markdown body of the formatted resume.
                blurb:
                  type: string
                  description: 2-3 sentence candidate-intro paragraph for the client.
                version_label:
                  type: string
                  description: Optional label, e.g. "v1 — Goldman MD". Defaults to "GPT v1".
                recruiter_email:
                  type: string
                  description: Optional — Emerald recruiter's email for attribution.
      responses:
        "200":
          description: Saved.
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok: { type: boolean }
                  send_out_id: { type: string }
                  formatted_resume_id: { type: string }
                  stage: { type: string }
                  previous_stage: { type: string, nullable: true }
```

## Appendix C — curl smoke tests

Replace `$DOMAIN` and `$SR_KEY` with your Vercel domain and Supabase
service-role key.

```bash
# 1. Search
curl -s -X POST "$DOMAIN/api/gpt/search-candidate-and-job" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"candidate_query":"smith","job_query":"vp"}' | jq .

# 2. Fetch (use IDs from the search response)
curl -s -X POST "$DOMAIN/api/gpt/fetch-sendout-context" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"candidate_id":"<UUID>","job_id":"<UUID>"}' | jq .

# 3. Save (only run against a test pairing)
curl -s -X POST "$DOMAIN/api/gpt/save-formatted-sendout" \
  -H "Authorization: Bearer $SR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "candidate_id":"<UUID>",
    "job_id":"<UUID>",
    "formatted_resume_text":"## Test\n\nLorem ipsum.",
    "blurb":"Test blurb.",
    "version_label":"smoke-test"
  }' | jq .
```
