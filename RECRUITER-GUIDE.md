# Recruiter Guide — Resumes, Clients & Pipeline

A practical walkthrough of the flows you'll use every day:
1. **Uploading resumes** so candidates land in the system.
2. **Managing clients** so client contacts, companies, interviews, and relationship notes stay usable.
3. **Moving a candidate through the pipeline** — Pitch → Send Out → Submission → Interview → Offer → Placed.

---

## 1. Uploading resumes

There are three places you can drop a resume. Pick the one that matches what you're doing.

### A. Bulk upload from the Candidates page

**When:** You have one or more resumes and want them parsed into candidate records (not yet attached to a specific job).

1. Go to **Candidates** in the left nav.
2. Click **Upload Resumes** in the top toolbar (next to *Ask Joe*).
3. Drop files into the zone, or click to browse. Multiple files at once is fine.
4. **Accepted file types:** PDF, DOC, DOCX, TXT.
5. The AI parses each file and shows you an extracted preview — name, email, phone, current title/company, location, LinkedIn URL.
6. Edit any field that looks off, then click **Save**.
7. Behavior:
   - If the email matches an existing candidate, that record is **updated** (not duplicated).
   - If it's new, a fresh candidate is created.
   - The resume file is stored on the candidate and indexed for search / Joe.

> If a file fails to parse, you'll see it surfaced in the Orphan Resumes tab (Settings → Admin). The system retries automatically.

### B. Attach a resume to an existing send-out

**When:** A candidate is already in the pipeline for a job and you want to attach (or swap) the version that goes to the client.

1. Open **Send Outs** (or the **Job Detail** page).
2. Click the candidate row to open the sidebar drawer.
3. In the send-out card, click **Upload Resume**.
4. The new resume is attached to that send-out specifically (without overwriting the candidate's master resume).

### C. Drop a resume from the candidate's profile

**When:** You're already viewing a candidate and want to add another resume version to their profile.

1. Open the candidate's detail page.
2. Use the **Resume drop zone** in the Resume section.
3. Drag-and-drop or click to browse.

---

## 2. Clients: contacts, background, and interview history

The left-nav **Clients** page is the desk view for hiring managers, client contacts, and dual-role people who also appear as candidates.

- Use the row `...` menu to **Edit Client**, open the profile, fetch message history, create tasks, change status, or enroll the client in a sequence.
- The table shows **Last Reached Out** and **Last Responded** as sortable columns. Out-of-office auto-replies, returned mail, bounces, and not-delivered signals do **not** count as a real response; they show as warning pills so you do not keep emailing a bad/OOO address.
- Status is still only `New`, `Reached Out`, or `Engaged`. A real human reply moves the client toward **Engaged**; an OOO/bounce does not.

On a client profile:

- Use the top `...` menu to edit the client, jump to the company linker, connect jobs, or open the linked company.
- The **Background** tab holds editable relationship notes, client notes, work history, and education. Resume parsing, LinkedIn/Unipile enrichment, call notes, and manual edits all feed the same searchable person record for Joe.
- The **Interviews** tab shows interviews tied through the linked company and linked jobs. Open an interview to see the round detail, prep notes, outcome, and debrief notes.

---

## 3. The pipeline: Pitch → Send Out → Submission

Every job has its own pipeline of candidates. A candidate's position in the pipeline is tracked as a **send_out** row — one per (candidate, job) pairing.

### Stages

The canonical stage order in the system:

| Stage         | What it means                                                                 |
| ------------- | ----------------------------------------------------------------------------- |
| **Pitch**     | Candidate is qualified — you haven't yet pitched the role to them.            |
| **Send Out**  | Candidate has been pitched and agreed. Queued to send to the client.          |
| **Submission**| Candidate has been formally submitted to the client. Waiting for feedback.    |
| **Interview** | Candidate is in the client's interview process. Round tracked separately.    |
| **Offer**     | Client has extended an offer.                                                 |
| **Placed**    | Win — candidate accepted and started.                                         |
| **Withdrawn** | Terminal exit — candidate or client backed out.                              |

### Adding a candidate to the pipeline (entering at "Pitch")

You've got two ways in:

**Option 1 — From the Send Outs page**
1. Click **+ New Send Out** (gold button, top-right).
2. Pick the candidate and the job.
3. Stage defaults to **Pitch**. Hit save.

**Option 2 — From the Job Detail page**
1. Open the job.
2. Click **Add to Pipeline** in the header.
3. Pick the candidate. They're added at **Pitch**.

### Moving between stages

Three ways to advance a candidate. Use whichever's faster for the situation.

**1. Drag-and-drop (Send Outs page)**
- Grab the candidate card and drag it into the destination stage column.
- The target column auto-expands when you hover.
- Desktop only.

**2. The Advance arrow (per-row)**
- The `→` button on the right side of each row.
- Moves to the **next stage in order**. Can't skip stages this way.

**3. The "Move to" picker (sidebar drawer)**
- Click any row to open the drawer.
- Tap any other stage chip in the **Move to** section.
- This is the only way to jump backward or skip multiple stages.

### What happens at each transition

| Transition                  | What pops up                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- |
| **→ Send Out**              | Notes dialog — capture a quick "ready to send" note.                         |
| **→ Submission**            | Notes dialog — pre-fills with the prior stage's note so you only edit what changed. |
| **→ Withdrawn**             | Reason dialog — capture *why* (client decision, candidate declined, recruiter pull). |
| **Anything else**           | Move happens instantly.                                                      |

### Recording what you actually submitted (Submission stage)

When you click a row in the **Submission** stage (or any later stage), the sidebar shows a **Submitted to client** card. Fill it in so the record matches what you actually told the client:

- **Base comp range** — e.g. `120k` and `140k` (shorthand works: `120k`, `120,000`, `$120k`, `1.2M` all parse).
- **Bonus comp range** — same shorthand.
- **Right to work here** — free text: `US Citizen`, `H1B`, `Sponsorship required`, etc.

Click **Save submission details**. These values are snapshotted on the send-out, so changing the candidate's profile later won't rewrite history.

### NEW: Format & submit with Joe (one guided flow)

Instead of manually attaching a resume and emailing the client yourself, open a
candidate's drawer and click **Ask Joe — format & submit**. This walks you
through, in order:

1. **Choose** — confirm the candidate + job.
2. **Formatting** — Joe reformats the resume into the **Emerald house style** (a
   branded PDF). Not happy with something? Type a note in **"Notes for Joe"** and
   it re-formats — you can keep refining; Joe always rebuilds from the original
   resume so edits never compound.
3. **Preview** — review the branded PDF and download it.
4. **Email** — a pre-drafted client email with the PDF attached. Edit the
   recipients/subject/body, then **send now** or **schedule** it for later.

When the email goes (or is scheduled), the candidate moves to **Submission** and
the email is snapshotted on the send-out. Comp / right-to-work captured in the
**Submitted to client** card flow into the draft.

> There's also a ChatGPT-based version of this for power users — same idea,
> driven from a custom GPT. Ask engineering if you want it set up.

### NEW: Interviews (Planner)

Once a candidate reaches the interview stage, track it under **Planner →
Interviews**. Each **round is its own entry** with its own date, who's
interviewing, prep notes, and a **debrief** (outcome + notes, and the recorded
debrief call if you logged one). Use **New Interview** / **New round** to add
more. Scheduling an interview drops a non-blocking marker on your calendar (and
always Chris's).

### What you see on the Send Outs page

- **KPI tiles** at the top: pitches, send-outs, submissions, interviews, offers, projected fee.
- **Filters**: search by name/title/company, filter by job, recruiter, date range.
- **Stage columns**: each stage is its own collapsible table. Click the header to collapse a column.
- **Per-row info** (in order): candidate name + role + company, stacked **Base / Bonus** comp range, **RTW** status, last touch date, days in stage, next-step note, action buttons.
- **Action buttons** (right side of each row): email, SMS, call, LinkedIn, notes, advance arrow, open profile, delete.

---

## Daily flow at a glance

1. **Morning** — upload any new resumes from the Candidates page (Flow 1A).
2. Check **Clients** for replies, OOO/bounce warnings, and client tasks before continuing any sequence.
3. Triage new candidates → drop them into jobs at **Pitch** stage.
4. As you pitch each candidate, move them to **Send Out**.
5. When you submit to the client, move to **Submission** *and fill in the Submitted to client card* (base + bonus + RTW). This is what protects your record of what was sent.
6. As feedback comes in, advance to **Interview** → **Offer** → **Placed**, or move to **Withdrawn** with a reason.

---

## Troubleshooting

- **Resume didn't parse.** Check Settings → Admin → Orphan Resumes. The system retries on its own; if a file's been stuck for >1 hour, drop a note to engineering.
- **Wrong candidate matched on email.** Open the candidate from the parse preview before saving — you can pick "Create new" instead of updating the matched record.
- **Comp / RTW look wrong on a past submission.** Open that send-out's drawer and edit; the changes save to that send-out's record only.
- **Need to move a candidate backward.** Use the **Move to** picker in the drawer — the per-row Advance arrow only goes forward.
- **A sequence keeps skipping a client.** Check the client row for `Email invalid`, `OOO`, or `Do Not Contact`. Invalid email/bounce flags stop future email sequence work until the address is corrected.
