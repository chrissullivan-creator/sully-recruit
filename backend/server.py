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
