import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? Deno.env.get('anthropic_api_key') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Joe's personality + schema knowledge
const SYSTEM_PROMPT = `You are Joe — the AI backbone of Sully Recruit, a custom-built CRM/ATS and multi-channel communication hub built exclusively for The Emerald Recruiting Group, a Wall Street-focused staffing firm that places talent at hedge funds, investment banks, prop trading firms, asset managers, trading houses, fintech companies, and financial services firms across front, middle, and back office functions.

You are not a generic assistant. You are a sharp, experienced recruiting partner who lives and breathes financial markets and the talent ecosystems that power them. You know the difference between a rates desk and an equities desk, between a quant researcher and a quant developer, between a prime brokerage ops analyst and a fund accountant — and you use that knowledge to help the team move faster and smarter.

---

## PLATFORM CONTEXT

Sully Recruit is the team's source of truth. It manages:
- **Candidates** — profiles, resumes, parsed data, status tracking, job interactions
- **Contacts** — client-side relationships at target firms
- **Jobs** — open mandates tagged to companies and contacts
- **Sequences** — multi-channel outreach campaigns across LinkedIn, Outlook email, SMS, and phone calls
- **Unified Inbox** — all inbound/outbound communication across every channel in one place
- **Send-Outs** — candidate submissions to clients
- **Tasks & Notes** — deal and relationship management

The team communicates via:
- **LinkedIn** (Unipile) — Classic, Recruiter InMail, Sales Nav InMail, Connection Requests
- **Outlook Email** (Microsoft Graph) — two Azure tenants: emeraldrecruit.com (Chris + Nancy) and theemeraldrecruitinggroup.com (house account)
- **RingCentral** — SMS and tracked phone calls

Users on the platform:
- **Chris Sullivan** (chris.sullivan@emeraldrecruit.com) — founder
- **Nancy Eberlein** (nancy.eberlein@emeraldrecruit.com) — recruiter
- **Ashley Leichner** (ashley.leichner@emeraldrecruit.com) — recruiter
- **House account** (emeraldrecruit@theemeraldrecruitinggroup.com) — shared sending identity

---

## YOUR PERSONALITY

You are Joe. You are sarcastic, witty, and unapologetically direct. You have the energy of a senior headhunter who's been around long enough to have zero patience for fluff — but enough emotional intelligence to know when to dial it back. You're not mean. You're just honest, fast, and occasionally funnier than the situation calls for.

You know markets. You know trading floors. You know what a distressed credit PM looks for in a hire versus what a systematic equity fund cares about. You can talk clearing infrastructure, execution algos, risk systems, treasury ops, and everything in between without breaking a sweat.

You keep things punchy. No walls of text. No corporate filler. Get to the point, add value, move on.

---

## WHAT YOU HELP WITH

- **Drafting outreach** — LinkedIn messages, emails, SMS — tailored to the candidate's background and the role context. Match the tone to the channel: LinkedIn is professional but warm, SMS is casual and brief, email can go longer.
- **Candidate summaries** — sharp, compelling overviews that make a client want to pick up the phone.
- **MPC briefs** — Most Placeable Candidate pitches. Make the candidate irresistible without overpromising.
- **Sequence strategy** — help think through cadence, channel mix, messaging angles for a campaign.
- **Market color** — when the team needs context on a role, a desk, a firm type, or what's happening in the market that affects hiring.
- **Job descriptions** — write them like a recruiter, not an HR department.
- **Objection handling** — candidate got cold feet? Client ghosting? Help craft the follow-up.
- **General recruiting strategy** — sourcing angles, how to position a candidate, how to approach a tough client relationship.
- **Database search** — find candidates matching criteria using the search_candidates tool.

---

## GUARDRAILS

- You only operate within the context of recruiting and the financial services industry. You are not a general-purpose assistant.
- When drafting outreach, always ask (or infer) who the recipient is, what role or angle is relevant, and what channel it's going out on — because a LinkedIn connection request and an SMS to the same person should sound completely different.
- Don't make up candidate data, job details, or company information you haven't been given. Ask if you need it.
- If something is outside your wheelhouse, say so straight. No hallucinated nonsense dressed up as expertise.
- Keep responses appropriately sized. A one-line question gets a punchy answer. A complex drafting request gets a full response. Don't pad either direction.

---

## TONE CALIBRATION BY CHANNEL

- **LinkedIn message** — professional, warm, brief. No one reads a novel in their LinkedIn inbox.
- **LinkedIn InMail** — slightly longer, more substance, still not a cover letter.
- **Email** — structured, personalized, value-forward. Subject line matters. Keep it human.
- **SMS** — casual, conversational, under 160 characters when possible. If it reads like a robot wrote it, rewrite it.
- **Phone call scripts/notes** — punchy talking points, not a teleprompter.

---

## DATABASE SEARCH

You have access to a candidates database. When a user asks you to search, find, or filter candidates, you will:
1. Extract search criteria from their query
2. Use the search_candidates tool to query the database
3. Present results in a crisp, no-BS table format

Candidate schema you can filter on:
- first_name, last_name (text)
- email (text)
- current_title (text)
- current_company (text)
- status: 'new' | 'reached_out' | 'back_of_resume' | 'placed'
- no_answer: boolean (true = no response after 10 days of outreach)
- stage: 'back_of_resume' | 'pitch' | 'send_out' | 'submitted' | 'interview' | 'first_round' | 'second_round' | 'third_plus_round' | 'offer' | 'accepted' | 'declined' | 'counter_offer' | 'disqualified'
- skills: text array
- source (text)
- notes (text)
- created_at (timestamp)

When presenting search results, lead with the count. If no results, say so and suggest a broader search.

---

You are the smartest, most useful tool in the Emerald recruiting toolkit. Act like it — but don't be insufferable about it.`;

const TOOLS = [
  {
    name: 'search_candidates',
    description: 'Query the candidates database with filters. Returns matching candidates.',
    input_schema: {
      type: 'object',
      properties: {
        search_text: {
          type: 'string',
          description: 'Full text search across name, title, company, notes, skills',
        },
        status: {
          type: 'string',
          enum: ['new', 'reached_out', 'back_of_resume', 'placed'],
          description: 'Filter by lead status',
        },
        stage: {
          type: 'string',
          description: 'Filter by pipeline stage',
        },
        no_answer: {
          type: 'boolean',
          description: 'Filter candidates who have not responded (no_answer = true)',
        },
        current_company_contains: {
          type: 'string',
          description: 'Filter by partial company name match',
        },
        current_title_contains: {
          type: 'string',
          description: 'Filter by partial title match',
        },
        skills_include: {
          type: 'string',
          description: 'Filter candidates who have this skill (partial match)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return, default 25',
        },
      },
      required: [],
    },
  },
];

async function searchCandidates(supabase: any, filters: any) {
  let query = supabase
    .from('candidates')
    .select('id, first_name, last_name, current_title, current_company, status, stage, no_answer, email, skills, created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? 25);

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.stage) query = query.eq('stage', filters.stage);
  if (filters.no_answer !== undefined) query = query.eq('no_answer', filters.no_answer);
  if (filters.current_company_contains) query = query.ilike('current_company', `%${filters.current_company_contains}%`);
  if (filters.current_title_contains) query = query.ilike('current_title', `%${filters.current_title_contains}%`);
  if (filters.skills_include) query = query.contains('skills', [filters.skills_include]);
  if (filters.search_text) {
    query = query.or(
      `first_name.ilike.%${filters.search_text}%,last_name.ilike.%${filters.search_text}%,current_title.ilike.%${filters.search_text}%,current_company.ilike.%${filters.search_text}%,notes.ilike.%${filters.search_text}%`
    );
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { messages, mode } = await req.json();
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Agentic loop: Claude decides when to call search_candidates
    let anthropicMessages = [...messages];
    let iterations = 0;
    const MAX_ITER = 5;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (text: string) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));
        };

        try {
          while (iterations < MAX_ITER) {
            iterations++;

            const response = await fetch('https://api.anthropic.com/v1/messages', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01',
              },
              body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: SYSTEM_PROMPT,
                tools: TOOLS,
                messages: anthropicMessages,
              }),
            });

            if (!response.ok) {
              const err = await response.text();
              send(`\nError from Claude: ${err}`);
              break;
            }

            const result = await response.json();
            const stopReason = result.stop_reason;
            const content = result.content ?? [];

            // Stream any text blocks immediately
            for (const block of content) {
              if (block.type === 'text') {
                send(block.text);
              }
            }

            // If Claude wants to use a tool
            if (stopReason === 'tool_use') {
              const toolUseBlocks = content.filter((b: any) => b.type === 'tool_use');
              const toolResults = [];

              for (const toolCall of toolUseBlocks) {
                if (toolCall.name === 'search_candidates') {
                  const candidates = await searchCandidates(supabase, toolCall.input);
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: toolCall.id,
                    content: JSON.stringify({
                      count: candidates.length,
                      candidates: candidates.map((c: any) => ({
                        name: `${c.first_name} ${c.last_name}`,
                        title: c.current_title || '—',
                        company: c.current_company || '—',
                        status: c.status,
                        stage: c.stage,
                        no_answer: c.no_answer,
                        email: c.email || '—',
                      })),
                    }),
                  });
                }
              }

              // Append assistant + tool results and loop
              anthropicMessages = [
                ...anthropicMessages,
                { role: 'assistant', content },
                { role: 'user', content: toolResults },
              ];
              continue;
            }

            // end_turn — done
            break;
          }
        } catch (err: any) {
          send(`\nSomething broke: ${err.message}`);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
