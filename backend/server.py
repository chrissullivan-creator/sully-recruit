from fastapi import FastAPI, APIRouter
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import json
import httpx
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional
import uuid
from datetime import datetime
from emergentintegrations.llm.chat import LlmChat, UserMessage


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Supabase config
SUPABASE_URL = os.environ.get('SUPABASE_URL', '')
SUPABASE_KEY = os.environ.get('SUPABASE_KEY', '')
EMERGENT_LLM_KEY = os.environ.get('EMERGENT_LLM_KEY', '')

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")


# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class StatusCheckCreate(BaseModel):
    client_name: str

class ChatMessage(BaseModel):
    role: str
    content: str

class ResumeSearchRequest(BaseModel):
    query: str
    messages: List[ChatMessage] = []
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

class StepWriteRequest(BaseModel):
    job_title: Optional[str] = None
    job_company: Optional[str] = None
    job_description: Optional[str] = None
    channel: str  # email, linkedin_recruiter, linkedin_message, linkedin_connection, sms, phone
    step_number: int
    total_steps: int
    is_reply: bool = False
    existing_content: Optional[str] = None
    sequence_name: Optional[str] = None
    instructions: Optional[str] = None

class MatchCandidatesRequest(BaseModel):
    job_title: str
    job_company: Optional[str] = None
    job_location: Optional[str] = None
    job_description: Optional[str] = None
    job_salary: Optional[str] = None



# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find().to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]


async def fetch_resume_data() -> list:
    """Fetch candidate resumes with candidate info from Supabase."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []

    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=30) as http:
        # Fetch resumes with summaries
        resumes_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/candidate_resumes",
            headers=headers,
            params={
                "select": "candidate_id,ai_summary,raw_text,file_name",
                "order": "created_at.desc",
                "limit": "500",
            },
        )
        if resumes_resp.status_code != 200:
            logger.error(f"Failed to fetch resumes: {resumes_resp.status_code} {resumes_resp.text}")
            return []
        resumes = resumes_resp.json()

        # Get unique candidate IDs
        cand_ids = list(set(r["candidate_id"] for r in resumes if r.get("candidate_id")))
        if not cand_ids:
            return []

        # Fetch candidate details in batches
        candidates_map = {}
        batch_size = 50
        for i in range(0, len(cand_ids), batch_size):
            batch = cand_ids[i:i + batch_size]
            ids_filter = ",".join(f'"{cid}"' for cid in batch)
            cands_resp = await http.get(
                f"{SUPABASE_URL}/rest/v1/candidates",
                headers=headers,
                params={
                    "select": "id,full_name,first_name,last_name,current_title,current_company,email,location,status",
                    "id": f"in.({ids_filter})",
                },
            )
            if cands_resp.status_code == 200:
                for c in cands_resp.json():
                    candidates_map[c["id"]] = c

        # Merge resume + candidate data
        result = []
        for r in resumes:
            cid = r.get("candidate_id")
            cand = candidates_map.get(cid, {})
            name = cand.get("full_name") or f"{cand.get('first_name', '')} {cand.get('last_name', '')}".strip() or "Unknown"

            # Use ai_summary if available, otherwise truncate raw_text
            summary = r.get("ai_summary") or ""
            if not summary and r.get("raw_text"):
                summary = r["raw_text"][:2000]

            if not summary:
                continue

            result.append({
                "candidate_id": cid,
                "name": name,
                "title": cand.get("current_title", ""),
                "company": cand.get("current_company", ""),
                "email": cand.get("email", ""),
                "location": cand.get("location", ""),
                "status": cand.get("status", ""),
                "summary": summary,
            })

        return result


@api_router.post("/write-sequence-step")
async def write_sequence_step(request: StepWriteRequest):
    """Ask Joe to write a sequence step with Emerald Recruiting style."""

    if not EMERGENT_LLM_KEY:
        return {"error": "LLM key not configured"}

    channel_labels = {
        'email': 'Email',
        'linkedin_recruiter': 'LinkedIn Recruiter InMail',
        'sales_nav': 'Sales Navigator InMail',
        'linkedin_message': 'LinkedIn Direct Message',
        'linkedin_connection': 'LinkedIn Connection Request',
        'sms': 'SMS Text',
        'phone': 'Phone Call Script',
    }
    ch_label = channel_labels.get(request.channel, request.channel)

    job_context = ""
    if request.job_title:
        job_context = f"\n\nJob: {request.job_title}"
        if request.job_company:
            job_context += f" at {request.job_company}"
        if request.job_description:
            job_context += f"\nJob Description: {request.job_description[:500]}"

    system_prompt = f"""You are Joe, the AI writing assistant for Emerald Recruiting Group (also known as Sully Recruit). You write outreach messages in the Emerald style — professional but warm, direct but not pushy, confident but respectful. The tone is polished executive recruiting: personable, succinct, and always focused on the candidate's career opportunity.

Emerald Style Guidelines:
- Open with something personal or specific — never generic "I came across your profile"
- Be concise — recruiters are busy, candidates are busy
- Lead with the opportunity/value, not with yourself
- Use {{{{first_name}}}}, {{{{company}}}}, {{{{title}}}} for personalization tokens
- Sound human, not templated
- For follow-ups/replies: reference the previous touchpoint naturally
- For LinkedIn connection requests: keep under 300 characters
- For SMS: keep under 160 characters
- For phone scripts: bullet points with talking points
- End with a clear, low-friction CTA (not "let me know if interested" — something specific like "open to a quick 10-min call this week?")

You are writing Step {request.step_number} of {request.total_steps} in a {ch_label} sequence.
{"This is a follow-up/reply to a previous email in the thread." if request.is_reply else "This is the first touch on this channel."}
{f"Sequence name: {request.sequence_name}" if request.sequence_name else ""}
{job_context}
{f"Additional instructions: {request.instructions}" if request.instructions else ""}

Return ONLY the message body text. No subject line unless this is an email first touch (not a reply). If it's an email first touch, put the subject on the first line prefixed with "Subject: " then a blank line then the body."""

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"step-write-{uuid.uuid4()}",
            system_message=system_prompt,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        prompt = f"Write a {ch_label} message for step {request.step_number} of {request.total_steps}."
        if request.existing_content:
            prompt += f"\n\nCurrent draft to improve:\n{request.existing_content}"
        if request.instructions:
            prompt += f"\n\nSpecific request: {request.instructions}"

        response = await chat.send_message(UserMessage(text=prompt))
        return {"content": response}
    except Exception as e:
        logger.error(f"Step write error: {e}")
        return {"error": str(e)}


async def fetch_candidates_for_matching() -> list:
    """Fetch candidate summaries for job matching."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return []
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30) as http:
        resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/candidates",
            headers=headers,
            params={
                "select": "id,full_name,first_name,last_name,current_title,current_company,email,location_text,status,skills,current_base_comp,target_roles,work_authorization",
                "order": "created_at.desc",
                "limit": "500",
            },
        )
        if resp.status_code != 200:
            return []
        return resp.json()


@api_router.post("/match-candidates-to-job")
async def match_candidates_to_job(request: MatchCandidatesRequest):
    """Use Claude to match existing candidates to a job."""
    if not EMERGENT_LLM_KEY:
        return {"error": "LLM key not configured"}

    candidates = await fetch_candidates_for_matching()
    if not candidates:
        return {"content": "No candidates found in the database to match against."}

    # Build candidate summaries
    cand_entries = []
    for c in candidates:
        name = c.get("full_name") or f"{c.get('first_name', '')} {c.get('last_name', '')}".strip()
        if not name:
            continue
        parts = [f"**{name}**"]
        if c.get("current_title"):
            parts.append(f"Title: {c['current_title']}")
        if c.get("current_company"):
            parts.append(f"Company: {c['current_company']}")
        if c.get("location_text"):
            parts.append(f"Location: {c['location_text']}")
        if c.get("target_roles"):
            parts.append(f"Target Roles: {c['target_roles']}")
        if c.get("work_authorization"):
            parts.append(f"Work Auth: {c['work_authorization']}")
        if c.get("status"):
            parts.append(f"Status: {c['status']}")
        cand_entries.append("\n".join(parts))

    cand_context = "\n\n---\n\n".join(cand_entries[:200])

    job_desc = f"Job: {request.job_title}"
    if request.job_company:
        job_desc += f" at {request.job_company}"
    if request.job_location:
        job_desc += f"\nLocation: {request.job_location}"
    if request.job_salary:
        job_desc += f"\nSalary: {request.job_salary}"
    if request.job_description:
        job_desc += f"\nDescription: {request.job_description[:1000]}"

    system_prompt = f"""You are Joe, the AI recruiting assistant for Emerald Recruiting Group. You analyze candidates in the database to find the best matches for a specific job.

Instructions:
1. Rank ALL potential matches from highest confidence to lowest
2. Show confidence percentage for each (e.g., "92% match")
3. Explain WHY each person is a good fit — reference their title, company, skills, location
4. Flag any concerns (location mismatch, overqualified, etc.)
5. Group into tiers: Strong Match (80%+), Good Match (60-79%), Worth Considering (40-59%)
6. Be thorough — show everyone who could potentially fit, not just top 5

{job_desc}

Candidates in database:
{cand_context}"""

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"match-{uuid.uuid4()}",
            system_message=system_prompt,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        response = await chat.send_message(UserMessage(text=f"Find the best candidate matches for: {request.job_title}" + (f" at {request.job_company}" if request.job_company else "")))
        return {"content": response}
    except Exception as e:
        logger.error(f"Match error: {e}")
        return {"error": str(e)}



@api_router.post("/resume-search-ai")
async def resume_search_ai(request: ResumeSearchRequest):
    """AI-powered resume search using Claude to analyze candidate resumes."""

    if not EMERGENT_LLM_KEY:
        return {"error": "LLM key not configured"}

    # Fetch resume data
    resume_data = await fetch_resume_data()

    if not resume_data:
        async def empty_stream():
            yield f"data: {json.dumps({'content': 'No resumes found in the database. Upload some resumes first, then try again.'})}\n\n"
        return StreamingResponse(empty_stream(), media_type="text/event-stream")

    # Build resume context - keep it concise
    resume_entries = []
    for i, r in enumerate(resume_data):
        entry = f"**Candidate #{i+1}: {r['name']}**"
        if r['title']:
            entry += f"\nTitle: {r['title']}"
        if r['company']:
            entry += f"\nCompany: {r['company']}"
        if r['location']:
            entry += f"\nLocation: {r['location']}"
        if r['email']:
            entry += f"\nEmail: {r['email']}"
        entry += f"\nResume Summary:\n{r['summary'][:1500]}"
        resume_entries.append(entry)

    resume_context = "\n\n---\n\n".join(resume_entries)

    # Truncate if too long (keep under ~100k chars for Claude)
    if len(resume_context) > 100000:
        resume_context = resume_context[:100000] + "\n\n[... additional resumes truncated due to length ...]"

    system_prompt = f"""You are Joe, a senior recruiting assistant at Sully Recruit. You have access to {len(resume_data)} candidate resumes in the database.

Your job is to search through these resumes and find the best matches for what the recruiter asks. When answering:

1. **Rank candidates by fit** — best matches first, with a confidence percentage (e.g., "95% match")
2. **Show ALL relevant candidates** — don't limit to just a few. If 20 people match, show all 20.
3. **Explain why each person matches** — reference specific skills, experience, or background from their resume
4. **Be specific** — mention actual companies, years of experience, technologies, certifications
5. **Format clearly** — use numbered lists with candidate name, title, company, match %, and reasoning
6. **If asked follow-ups**, remember the context and refine your search

Here are the candidate resumes:

{resume_context}

Remember: Show ALL matching candidates ranked from highest to lowest confidence. Don't artificially limit results."""

    # Build conversation
    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=request.session_id,
        system_message=system_prompt,
    ).with_model("anthropic", "claude-sonnet-4-5-20250929")

    # Build full message from history + new query
    full_query = ""
    for msg in request.messages:
        if msg.role == "user":
            full_query = msg.content
    if request.query:
        full_query = request.query

    user_msg = UserMessage(text=full_query)

    async def stream_response():
        try:
            response = await chat.send_message(user_msg)
            # Send the full response as a stream of chunks
            chunk_size = 50
            for i in range(0, len(response), chunk_size):
                chunk = response[i:i + chunk_size]
                yield f"data: {json.dumps({'content': chunk})}\n\n"
        except Exception as e:
            logger.error(f"Claude error: {e}")
            yield f"data: {json.dumps({'content': f'Error: {str(e)}'})}\n\n"

    return StreamingResponse(stream_response(), media_type="text/event-stream")



# ── Helpers for Supabase REST calls ──────────────────────────────────────────
def _sb_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
    }


# ── 1) Sync activity timestamps across all channels ─────────────────────────
class SyncActivityRequest(BaseModel):
    entity_type: str  # 'candidate' or 'contact'
    entity_id: str

@api_router.post("/sync-activity-timestamps")
async def sync_activity_timestamps(request: SyncActivityRequest):
    """Recalculate last_reached_out_at and last_responded_at by scanning messages, calls, SMS across all channels."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"error": "Supabase not configured"}

    headers = _sb_headers()
    etype = request.entity_type
    eid = request.entity_id

    async with httpx.AsyncClient(timeout=30) as http:
        # 1. Get entity details (email, phone, linkedin)
        table = 'candidates' if etype == 'candidate' else 'contacts'
        entity_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers={**headers, "Prefer": ""},
            params={"select": "id,email,phone,linkedin_url", "id": f"eq.{eid}"},
        )
        if entity_resp.status_code != 200 or not entity_resp.json():
            return {"error": "Entity not found"}
        entity = entity_resp.json()[0]

        # 2. Find all messages linked to this entity
        id_field = 'candidate_id' if etype == 'candidate' else 'contact_id'
        msgs_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/messages",
            headers={**headers, "Prefer": ""},
            params={
                "select": "direction,sent_at,received_at,created_at",
                id_field: f"eq.{eid}",
                "order": "created_at.desc",
                "limit": "500",
            },
        )
        messages = msgs_resp.json() if msgs_resp.status_code == 200 else []

        # 3. Find call logs linked to this entity
        calls_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/call_logs",
            headers={**headers, "Prefer": ""},
            params={
                "select": "direction,started_at,linked_entity_id",
                "linked_entity_id": f"eq.{eid}",
                "order": "started_at.desc",
                "limit": "100",
            },
        )
        calls = calls_resp.json() if calls_resp.status_code == 200 else []

        # 4. Also search messages by email/phone if available
        extra_messages = []
        if entity.get("email"):
            for field in ["sender_address", "recipient_address"]:
                resp = await http.get(
                    f"{SUPABASE_URL}/rest/v1/messages",
                    headers={**headers, "Prefer": ""},
                    params={
                        "select": "direction,sent_at,received_at,created_at",
                        field: f"eq.{entity['email']}",
                        "order": "created_at.desc",
                        "limit": "200",
                    },
                )
                if resp.status_code == 200:
                    extra_messages.extend(resp.json())

        all_messages = messages + extra_messages
        # Deduplicate by checking unique combinations
        seen = set()
        unique_msgs = []
        for m in all_messages:
            key = (m.get("sent_at"), m.get("received_at"), m.get("direction"))
            if key not in seen:
                seen.add(key)
                unique_msgs.append(m)

        # 5. Calculate timestamps
        last_reached = None
        last_responded = None

        # Outbound messages = reached out
        for m in unique_msgs:
            if m.get("direction") == "outbound":
                ts = m.get("sent_at") or m.get("created_at")
                if ts and (not last_reached or ts > last_reached):
                    last_reached = ts
            elif m.get("direction") == "inbound":
                ts = m.get("received_at") or m.get("sent_at") or m.get("created_at")
                if ts and (not last_responded or ts > last_responded):
                    last_responded = ts

        # Outbound calls = reached out, inbound = responded
        for c in calls:
            ts = c.get("started_at")
            if not ts:
                continue
            if c.get("direction") == "outbound":
                if not last_reached or ts > last_reached:
                    last_reached = ts
            else:
                if not last_responded or ts > last_responded:
                    last_responded = ts

        # 6. Update the entity record
        update_data = {}
        if etype == 'contact':
            # contacts have last_reached_out_at and last_responded_at columns
            if last_reached:
                update_data["last_reached_out_at"] = last_reached
            if last_responded:
                update_data["last_responded_at"] = last_responded
        else:
            # candidates might not have these columns - store in updated_at or custom field
            # We'll try updating and ignore errors for missing columns
            if last_reached:
                update_data["last_reached_out_at"] = last_reached
            if last_responded:
                update_data["last_responded_at"] = last_responded

        if update_data:
            await http.patch(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers=headers,
                params={"id": f"eq.{eid}"},
                json=update_data,
            )

        return {
            "last_reached_out_at": last_reached,
            "last_responded_at": last_responded,
            "messages_scanned": len(unique_msgs),
            "calls_scanned": len(calls),
        }


# ── 2) Nudge check — email Chris about stagnant pipeline ────────────────────
@api_router.post("/run-nudge-check")
async def run_nudge_check():
    """Scan pipeline for stagnation, create tasks, and email Chris."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"error": "Supabase not configured"}

    headers = _sb_headers()
    chris_email = "chris.sullivan@emeraldrecruit.com"
    stagnation_days = 7
    cutoff = (datetime.utcnow().replace(hour=0, minute=0, second=0) - __import__('datetime').timedelta(days=stagnation_days)).isoformat()

    async with httpx.AsyncClient(timeout=30) as http:
        # Find active candidates with no recent activity
        cands_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/candidates",
            headers={**headers, "Prefer": ""},
            params={
                "select": "id,full_name,current_title,current_company,status,owner_id,updated_at",
                "status": "in.(new,reached_out,back_of_resume)",
                "updated_at": f"lt.{cutoff}",
                "limit": "50",
            },
        )
        stagnant = cands_resp.json() if cands_resp.status_code == 200 else []

        # Find Chris's user ID
        profiles_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/profiles",
            headers={**headers, "Prefer": ""},
            params={"select": "id,email", "email": f"eq.{chris_email}"},
        )
        chris_id = None
        if profiles_resp.status_code == 200 and profiles_resp.json():
            chris_id = profiles_resp.json()[0]["id"]

        # Create tasks for stagnant candidates
        tasks_created = 0
        nudge_items = []
        for c in stagnant[:20]:  # Limit to 20 to avoid spam
            name = c.get("full_name", "Unknown")
            title = c.get("current_title", "")
            company = c.get("current_company", "")
            nudge_items.append(f"• {name} ({title} at {company}) — status: {c['status']}")

            if chris_id:
                task_data = {
                    "title": f"Follow up with {name}",
                    "description": f"No activity in {stagnation_days}+ days. {title} at {company}. Current status: {c['status']}",
                    "priority": "high",
                    "due_date": datetime.utcnow().strftime("%Y-%m-%d"),
                    "assigned_to": chris_id,
                    "created_by": chris_id,
                }
                resp = await http.post(
                    f"{SUPABASE_URL}/rest/v1/tasks",
                    headers=headers,
                    json=task_data,
                )
                if resp.status_code in (200, 201):
                    tasks_created += 1

        # Send email nudge to Chris via edge function
        if nudge_items and chris_id:
            email_body = f"Hi Chris,\n\n{len(stagnant)} candidates haven't had activity in {stagnation_days}+ days:\n\n" + "\n".join(nudge_items[:20])
            email_body += f"\n\nI've created {tasks_created} follow-up tasks in your To-Do's.\n\n— Joe (Sully Recruit AI)"

            try:
                await http.post(
                    f"{SUPABASE_URL}/functions/v1/send-message",
                    headers={**headers, "Prefer": ""},
                    json={
                        "channel": "email",
                        "to": chris_email,
                        "subject": f"🔔 {len(stagnant)} candidates need follow-up",
                        "body": email_body,
                    },
                )
            except Exception as e:
                logger.warning(f"Nudge email failed: {e}")

        return {
            "stagnant_candidates": len(stagnant),
            "tasks_created": tasks_created,
            "nudge_sent": len(nudge_items) > 0,
        }


# ── 3) Outlook calendar sync → To-Do's ──────────────────────────────────────
@api_router.post("/sync-outlook-events")
async def sync_outlook_events():
    """Pull upcoming Outlook events and create/match to-do items linked to candidates."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"error": "Supabase not configured"}

    headers = _sb_headers()

    async with httpx.AsyncClient(timeout=30) as http:
        # 1. Get Microsoft tokens from integration_accounts
        accts_resp = await http.get(
            f"{SUPABASE_URL}/rest/v1/integration_accounts",
            headers={**headers, "Prefer": ""},
            params={
                "select": "id,owner_user_id,user_id,access_token,refresh_token,account_type,provider,account_label",
                "provider": "eq.microsoft",
                "is_active": "eq.true",
            },
        )
        ms_accounts = accts_resp.json() if accts_resp.status_code == 200 else []

        if not ms_accounts:
            return {"error": "No active Microsoft accounts found. Connect Outlook in Settings first."}

        events_synced = 0
        events_matched = 0

        for acct in ms_accounts:
            access_token = acct.get("access_token")
            user_id = acct.get("owner_user_id") or acct.get("user_id")
            if not access_token or not user_id:
                continue

            # 2. Fetch upcoming events from Microsoft Graph
            now = datetime.utcnow().isoformat() + "Z"
            week_later = (datetime.utcnow() + __import__('datetime').timedelta(days=14)).isoformat() + "Z"

            try:
                graph_resp = await http.get(
                    "https://graph.microsoft.com/v1.0/me/calendarview",
                    headers={"Authorization": f"Bearer {access_token}"},
                    params={
                        "startDateTime": now,
                        "endDateTime": week_later,
                        "$select": "subject,start,end,attendees,bodyPreview",
                        "$top": "50",
                        "$orderby": "start/dateTime",
                    },
                )
                if graph_resp.status_code == 401:
                    # Token expired — skip this account
                    logger.info(f"Microsoft token expired for account {acct['id']}")
                    continue
                if graph_resp.status_code != 200:
                    continue
                events = graph_resp.json().get("value", [])
            except Exception as e:
                logger.warning(f"Graph API error: {e}")
                continue

            # 3. For each event, try to match attendees to candidates/contacts
            for event in events:
                subject = event.get("subject", "")
                start_dt = event.get("start", {}).get("dateTime", "")[:10]  # YYYY-MM-DD
                attendee_emails = [
                    a.get("emailAddress", {}).get("address", "").lower()
                    for a in event.get("attendees", [])
                    if a.get("emailAddress", {}).get("address")
                ]

                if not subject or not start_dt:
                    continue

                # Check if task already exists for this event
                existing_resp = await http.get(
                    f"{SUPABASE_URL}/rest/v1/tasks",
                    headers={**headers, "Prefer": ""},
                    params={
                        "select": "id",
                        "title": f"eq.📅 {subject}",
                        "due_date": f"eq.{start_dt}",
                        "created_by": f"eq.{user_id}",
                        "limit": "1",
                    },
                )
                if existing_resp.status_code == 200 and existing_resp.json():
                    continue  # Already synced

                # Create task
                task_resp = await http.post(
                    f"{SUPABASE_URL}/rest/v1/tasks",
                    headers={**headers, "Prefer": "return=representation"},
                    json={
                        "title": f"📅 {subject}",
                        "description": event.get("bodyPreview", "")[:500] or f"Outlook event: {subject}",
                        "priority": "medium",
                        "due_date": start_dt,
                        "assigned_to": user_id,
                        "created_by": user_id,
                    },
                )
                if task_resp.status_code not in (200, 201):
                    continue
                task = task_resp.json()
                task_id = task[0]["id"] if isinstance(task, list) else task.get("id")
                events_synced += 1

                # 4. Match attendee emails to candidates/contacts
                if task_id and attendee_emails:
                    for email_addr in attendee_emails:
                        # Try candidate match
                        cand_resp = await http.get(
                            f"{SUPABASE_URL}/rest/v1/candidates",
                            headers={**headers, "Prefer": ""},
                            params={"select": "id", "email": f"eq.{email_addr}", "limit": "1"},
                        )
                        if cand_resp.status_code == 200 and cand_resp.json():
                            await http.post(
                                f"{SUPABASE_URL}/rest/v1/task_links",
                                headers=headers,
                                json={"task_id": task_id, "entity_type": "candidate", "entity_id": cand_resp.json()[0]["id"]},
                            )
                            events_matched += 1
                            continue

                        # Try contact match
                        cont_resp = await http.get(
                            f"{SUPABASE_URL}/rest/v1/contacts",
                            headers={**headers, "Prefer": ""},
                            params={"select": "id", "email": f"eq.{email_addr}", "limit": "1"},
                        )
                        if cont_resp.status_code == 200 and cont_resp.json():
                            await http.post(
                                f"{SUPABASE_URL}/rest/v1/task_links",
                                headers=headers,
                                json={"task_id": task_id, "entity_type": "contact", "entity_id": cont_resp.json()[0]["id"]},
                            )
                            events_matched += 1

        return {
            "events_synced": events_synced,
            "events_matched": events_matched,
            "ms_accounts_checked": len(ms_accounts),
        }



# ── Send-Out: Parse resume text → structured JSON ────────────────────────────
class ParseResumeRequest(BaseModel):
    resume_text: str
    job_title: Optional[str] = None
    job_description: Optional[str] = None

@api_router.post("/parse-resume-ai")
async def parse_resume_ai(request: ParseResumeRequest):
    """Parse resume text into structured JSON using Claude."""
    if not EMERGENT_LLM_KEY:
        return {"error": "LLM key not configured"}

    job_context = ""
    if request.job_title:
        job_context += f"\nTarget job: {request.job_title}"
    if request.job_description:
        job_context += f"\nJob description: {request.job_description[:500]}"

    system_prompt = f"""You are a professional resume parser. Extract the following structured data from the resume text provided. Return ONLY valid JSON, no markdown, no explanation.
{job_context}

Return this exact JSON structure:
{{
  "name": "Full Name",
  "email": "email@example.com",
  "phone": "phone number",
  "linkedin": "LinkedIn URL",
  "location": "City, State",
  "summary": "2-3 sentence professional summary tailored to the target role if provided",
  "experience": [
    {{
      "company": "Company Name",
      "title": "Job Title",
      "start_date": "Month Year",
      "end_date": "Month Year or Present",
      "duration": "X years Y months",
      "responsibilities": ["bullet point 1", "bullet point 2"]
    }}
  ],
  "education": [
    {{
      "institution": "School Name",
      "degree": "Degree Type",
      "field": "Field of Study",
      "year": "Graduation Year"
    }}
  ],
  "skills": ["skill1", "skill2"],
  "certifications": ["cert1", "cert2"],
  "technical_systems": ["system1", "system2"]
}}

Group multiple titles at the same company together under one company entry with the company-level total duration. Each title gets its own duration within the company.
If tailoring to a job, emphasize relevant experience and skills."""

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"parse-{uuid.uuid4()}",
            system_message=system_prompt,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        response = await chat.send_message(UserMessage(text=f"Parse this resume:\n\n{request.resume_text[:8000]}"))

        # Extract JSON from response
        text = response.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            text = text.rsplit("```", 1)[0]
        parsed = json.loads(text)
        return {"data": parsed}
    except json.JSONDecodeError:
        return {"data": None, "raw": response, "error": "Failed to parse JSON from AI response"}
    except Exception as e:
        logger.error(f"Parse resume error: {e}")
        return {"error": str(e)}


# ── Send-Out: Generate email body with Claude ────────────────────────────────
class SendOutEmailRequest(BaseModel):
    candidate_name: str
    candidate_title: Optional[str] = None
    candidate_company: Optional[str] = None
    candidate_notes: Optional[str] = None
    compensation: Optional[str] = None
    job_title: Optional[str] = None
    job_company: Optional[str] = None
    job_description: Optional[str] = None
    contact_names: List[str] = []
    sender_name: Optional[str] = None

@api_router.post("/generate-sendout-email")
async def generate_sendout_email(request: SendOutEmailRequest):
    """Generate a send-out email in Emerald writing style."""
    if not EMERGENT_LLM_KEY:
        return {"error": "LLM key not configured"}

    greeting = "Hi,"
    if request.contact_names:
        if len(request.contact_names) == 1:
            greeting = f"Hi {request.contact_names[0].split()[0]},"
        else:
            greeting = "Hi,"

    system_prompt = """You are Joe, writing send-out emails for Emerald Recruiting Group. Write in the Emerald style: professional, warm, concise, human. 

Write ONLY the email body (no subject line, no greeting, no signature — those are handled separately). The body should be 3-5 sentences:
1. Brief candidate summary — who they are, what they do, standout qualities
2. What they're looking for in their next role + compensation expectations if known
3. Why they're a good fit for this specific role/company
4. Why they should be interested
5. Close with "Let me know your thoughts."

Use notes from the profile to make it personal. Sound like a human recruiter, not a template. Be specific about the candidate's background."""

    try:
        chat = LlmChat(
            api_key=EMERGENT_LLM_KEY,
            session_id=f"sendout-{uuid.uuid4()}",
            system_message=system_prompt,
        ).with_model("anthropic", "claude-sonnet-4-5-20250929")

        prompt = f"Write a send-out email body for:\n\nCandidate: {request.candidate_name}"
        if request.candidate_title:
            prompt += f"\nTitle: {request.candidate_title}"
        if request.candidate_company:
            prompt += f"\nCompany: {request.candidate_company}"
        if request.candidate_notes:
            prompt += f"\nNotes: {request.candidate_notes[:500]}"
        if request.compensation:
            prompt += f"\nCompensation: {request.compensation}"
        if request.job_title:
            prompt += f"\n\nJob: {request.job_title}"
        if request.job_company:
            prompt += f" at {request.job_company}"
        if request.job_description:
            prompt += f"\nJob details: {request.job_description[:300]}"

        response = await chat.send_message(UserMessage(text=prompt))
        return {"body": response.strip(), "greeting": greeting}
    except Exception as e:
        logger.error(f"Send-out email error: {e}")
        return {"error": str(e)}



# ── Backfill full_name for candidates/contacts missing it ────────────────────
@api_router.post("/backfill-full-names")
async def backfill_full_names():
    """Set full_name = first_name + ' ' + last_name for records missing it."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return {"error": "Supabase not configured"}

    headers = _sb_headers()
    fixed = 0

    async with httpx.AsyncClient(timeout=30) as http:
        for table in ['candidates', 'contacts']:
            # Get records where full_name is null but first/last exists
            resp = await http.get(
                f"{SUPABASE_URL}/rest/v1/{table}",
                headers={**headers, "Prefer": ""},
                params={
                    "select": "id,first_name,last_name,full_name",
                    "full_name": "is.null",
                    "limit": "500",
                },
            )
            if resp.status_code != 200:
                continue
            records = resp.json()

            for r in records:
                fn = (r.get("first_name") or "").strip()
                ln = (r.get("last_name") or "").strip()
                full = f"{fn} {ln}".strip()
                if not full:
                    continue
                await http.patch(
                    f"{SUPABASE_URL}/rest/v1/{table}",
                    headers=headers,
                    params={"id": f"eq.{r['id']}"},
                    json={"full_name": full},
                )
                fixed += 1

    return {"fixed": fixed}


# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
