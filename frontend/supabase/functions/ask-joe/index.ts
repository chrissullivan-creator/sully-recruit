import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Case-insensitive fallback — secret stored as lowercase in Supabase
const ANTHROPIC_API_KEY =
  Deno.env.get('ANTHROPIC_API_KEY') ??
  Deno.env.get('anthropic_api_key') ??
  '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const VOYAGE_API_KEY = Deno.env.get('VOYAGE_API_KEY') ?? '';
const VOYAGE_MODEL = 'voyage-finance-2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const EMERALD_STYLE_GUIDE = `
## THE EMERALD WRITING STYLE

Every message The Emerald Recruiting Group sends should feel like it came from a sharp, credible human who actually knows the candidate's world. Not a form letter. Not a recruiter bot.

### VOICE & TONE
- Confident but not arrogant. Warm without being sycophantic. No "Hope this finds you well" ever.
- Direct. Every sentence earns its place. Occasionally witty — a well-placed line is worth three paragraphs of polish.
- Human. Like a colleague who respects your time reaching out with something relevant.

### WHAT EMERALD MESSAGES ALWAYS DO
- Lead with something specific to the person. Generic openers are death.
- Name the opportunity clearly. Don't be coy.
- Establish credibility fast — track record, placement stats, domain expertise.
- Make a clear, low-friction ask. Coffee. A 15-minute call. Not "let me know if you're interested."
- Close with name, title, firm.

### WHAT EMERALD MESSAGES NEVER DO
- Open with "I hope this message finds you well" or any variant.
- Use buzzwords: synergy, leverage (verb), circle back, touch base.
- Oversell or overpromise.
- Be longer than they need to be.

### BY CHANNEL
**LinkedIn Connection Request (300 char limit):** One punchy sentence. Mention their firm or role. No pitch yet.
**LinkedIn Message:** 3-5 sentences max. Warm, specific, soft ask.
**LinkedIn InMail:** 4-7 sentences. Hook, credibility, CTA. Subject line is critical.
**Email:** Sharp subject. Opening hook, 2-3 sentences context/value, clear CTA. Signature with name, title, firm.
**SMS:** Casual. Under 160 chars ideally. First name. Quick context. Ask. Done.

### SIGNATURE STYLE
- First and last name | Title | The Emerald Recruiting Group
- Optional: "82% of our placements stay 2+ years"

### THE EMERALD DIFFERENTIATOR
- Selective. When we reach out, it means something.
- Long-term outcomes: 82% placement retention.
- Boutique Wall Street specialists. Not generalists with a finance vertical.
- Confidential. Always.
`;

const BASE_SYSTEM_PROMPT = `You are Joe — the AI backbone of Sully Recruit, built exclusively for The Emerald Recruiting Group, a Wall Street staffing firm placing talent at hedge funds, investment banks, prop trading firms, asset managers, fintech, and financial services firms across front, middle, and back office.

Sharp. Experienced. Direct. Senior headhunter energy — zero patience for fluff, enough EQ to know when to dial it back. You know markets: rates desks vs equity desks, quant researchers vs quant devs, prime brokerage ops vs fund accounting. Punchy. No walls of text.

## PLATFORM CONTEXT
Sully Recruit manages: Candidates, Contacts, Jobs, Sequences (multi-channel outreach), Unified Inbox, Send-Outs, Tasks & Notes.
Channels: LinkedIn via Unipile, Outlook Email via Microsoft Graph, RingCentral SMS/calls.
Team: Chris Sullivan (President), Nancy Eberlein (Managing Director), Ashley Leichner (Recruiter), House account.

## SEARCH TOOLS
Two ways to find candidates:
1. **search_candidates** — structured filters. Exact matches: status, company, title, skills.
2. **semantic_search_candidates** — AI semantic search via Voyage Finance-2. Use for natural language descriptions. Searches full resume + LinkedIn content. PREFER this for nuanced queries.

## DATA QUALITY IN SEARCH RESULTS
When displaying candidate search results, ALWAYS show data quality clearly:
- 📄✅ = Has resume + LinkedIn (most complete — ready to submit)
- 📄 = Resume only (submittable, no LinkedIn enrichment)
- 🔗 = LinkedIn profile only (interesting but get resume before submitting)

Lead every search result table with a summary line like:
"Found 12 candidates: 7 with resumes, 3 resume+LinkedIn, 2 LinkedIn only."

## CONTEXT TOOLS (for drafting)
- **get_candidate_context** — full profile, recent messages, sequence history, sentiment
- **get_contact_context** — full contact profile, message history
- **get_job_context** — job details, requirements, comp, hiring contact
Always pull context when IDs are provided before drafting a single word.

## GUARDRAILS
- Recruiting and financial services only.
- Don't make up data you haven't been given. Ask if you need it.
- Keep responses sized to the question. Punchy = punchy. Complex = full.

## TONE BY CHANNEL
- LinkedIn connection: 300 chars max. One hook. No pitch yet.
- LinkedIn message: 3-5 sentences. Warm, specific, soft ask.
- LinkedIn InMail: 4-7 sentences. Subject line first.
- Email: Subject first. Structured, human, clear CTA.
- SMS: Under 160 chars. First name. Quick context. Ask.

${EMERALD_STYLE_GUIDE}

You are the smartest tool in the Emerald recruiting toolkit. Act like it — but don't be insufferable about it.`;

const DRAFT_MESSAGE_SYSTEM_ADDENDUM = `
## DRAFT MESSAGE MODE
Your only job: write the best possible outreach message for Emerald.
1. If candidate_id, contact_id, or job_id are in context, ALWAYS call context tools first.
2. Synthesize everything: who they are, the role, the channel, who's sending it.
3. Write in The Emerald Writing Style. No generic openers. Real hook. Clear ask. Human close.
4. After the draft, offer 1-2 punchy variations or channel-swap notes.
5. Missing critical context? Ask one focused question. Don't guess.

### SIGNATURES
Chris: Chris Sullivan | President | The Emerald Recruiting Group
Nancy: Nancy Eberlein | Managing Director | The Emerald Recruiting Group
Ashley: Ashley Leichner | Recruiter | The Emerald Recruiting Group
House: The Emerald Recruiting Group Team
Default to Chris if sender unknown.
`;

const TOOLS = [
  {
    name: 'search_candidates',
    description: 'Query candidates with structured filters. Best for exact field matches: status, company, title, skills.',
    input_schema: {
      type: 'object',
      properties: {
        search_text: { type: 'string', description: 'Full text search across name, title, company, notes, skills' },
        status: { type: 'string', enum: ['new', 'reached_out', 'back_of_resume', 'placed'] },
        stage: { type: 'string' },
        no_answer: { type: 'boolean' },
        current_company_contains: { type: 'string' },
        current_title_contains: { type: 'string' },
        skills_include: { type: 'string' },
        limit: { type: 'number', description: 'Max results, default 25' },
      },
      required: [],
    },
  },
  {
    name: 'semantic_search_candidates',
    description: 'AI semantic candidate search using Voyage Finance-2. Use for natural language candidate descriptions. PREFER over search_candidates for nuanced queries.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language description. Be specific and finance-domain rich.' },
        match_count: { type: 'number', description: 'Candidates to return (default 10, max 25)' },
        filter_status: { type: 'string', description: 'Optional status filter: new, reached_out, back_of_resume, placed' },
        min_similarity: { type: 'number', description: 'Min similarity 0-1. Default 0.3.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_candidate_context',
    description: 'Fetch full candidate profile for drafting. Returns name, title, company, resume summary, LinkedIn, recent messages, sequences, sentiment. Always call before drafting about a candidate.',
    input_schema: {
      type: 'object',
      properties: { candidate_id: { type: 'string' } },
      required: ['candidate_id'],
    },
  },
  {
    name: 'get_contact_context',
    description: 'Fetch full contact profile for drafting. Returns name, title, firm, LinkedIn, notes, recent messages.',
    input_schema: {
      type: 'object',
      properties: { contact_id: { type: 'string' } },
      required: ['contact_id'],
    },
  },
  {
    name: 'get_job_context',
    description: 'Fetch job details for drafting. Returns title, firm, description, requirements, comp range, hiring contact.',
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
    },
  },
];

async function searchCandidates(supabase: any, filters: any) {
  let query = supabase
    .from('candidates')
    .select('id, first_name, last_name, current_title, current_company, status, stage, no_answer, email, skills, resume_url, created_at')
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
  return (data ?? []).map((c: any) => ({
    name: `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim(),
    title: c.current_title || '—',
    company: c.current_company || '—',
    status: c.status,
    stage: c.stage,
    email: c.email || '—',
    has_resume: !!c.resume_url,
  }));
}

async function semanticSearchCandidates(supabase: any, input: any) {
  const { query, match_count = 10, filter_status = null, min_similarity = 0.3 } = input;

  const voyageRes = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: VOYAGE_MODEL, input: [query], input_type: 'query' }),
  });
  if (!voyageRes.ok) throw new Error(`Voyage ${voyageRes.status}: ${await voyageRes.text()}`);

  const queryEmbedding: number[] = (await voyageRes.json()).data[0].embedding;

  const { data, error } = await supabase.rpc('match_candidates', {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: Math.min(match_count, 25),
    min_similarity,
    filter_status,
  });
  if (error) throw error;

  const results = (data ?? []) as any[];
  return {
    count: results.length,
    search_type: 'semantic',
    query,
    candidates: results.map((r: any) => ({
      name: r.full_name || '—',
      title: r.current_title || '—',
      company: r.current_company || '—',
      location: r.location_text || '—',
      status: r.status,
      match: `${Math.round(r.similarity * 100)}%`,
      has_resume: r.has_resume,
      has_linkedin: r.has_linkedin,
      badge: r.data_quality === 'resume+linkedin' ? '📄✅' : r.data_quality === 'resume_only' ? '📄' : '🔗',
    })),
  };
}

async function getCandidateContext(supabase: any, candidateId: string) {
  const { data: candidate, error } = await supabase
    .from('candidates')
    .select('id, first_name, last_name, full_name, current_title, current_company, email, phone, linkedin_url, location_text, status, stage, skills, notes, resume_url, candidate_summary, last_sequence_sentiment, last_sequence_sentiment_note, created_at')
    .eq('id', candidateId).maybeSingle();
  if (error || !candidate) throw new Error(`Candidate not found: ${candidateId}`);

  const { data: messages } = await supabase
    .from('messages').select('channel, direction, body, sent_at, subject')
    .eq('candidate_id', candidateId).order('sent_at', { ascending: false }).limit(10);

  const { data: enrollments } = await supabase
    .from('sequence_enrollments').select('status, current_step_order, enrolled_at, sequences(name)')
    .eq('candidate_id', candidateId).in('status', ['active', 'paused']).limit(3);

  return { profile: candidate, recent_messages: messages ?? [], active_sequences: enrollments ?? [] };
}

async function getContactContext(supabase: any, contactId: string) {
  const { data: contact, error } = await supabase
    .from('contacts')
    .select('id, first_name, last_name, full_name, title, company_name, email, phone, linkedin_url, notes, last_sequence_sentiment, last_sequence_sentiment_note, created_at')
    .eq('id', contactId).maybeSingle();
  if (error || !contact) throw new Error(`Contact not found: ${contactId}`);

  const { data: messages } = await supabase
    .from('messages').select('channel, direction, body, sent_at, subject')
    .eq('contact_id', contactId).order('sent_at', { ascending: false }).limit(10);

  return { profile: contact, recent_messages: messages ?? [] };
}

async function getJobContext(supabase: any, jobId: string) {
  const { data: job, error } = await supabase
    .from('jobs')
    .select('id, title, status, description, compensation, location, company_name, submittal_instructions, created_at')
    .eq('id', jobId).maybeSingle();
  if (error || !job) throw new Error(`Job not found: ${jobId}`);
  return job;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  if (!ANTHROPIC_API_KEY) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured in Supabase secrets' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = await req.json();
    const { messages, mode, context } = body;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let systemPrompt = BASE_SYSTEM_PROMPT;
    if (mode === 'draft_message') {
      systemPrompt += '\n\n' + DRAFT_MESSAGE_SYSTEM_ADDENDUM;
      if (context && Object.keys(context).length > 0) {
        systemPrompt += `\n\n## AVAILABLE CONTEXT IDs\n`;
        if (context.candidate_id) systemPrompt += `- candidate_id: ${context.candidate_id}\n`;
        if (context.contact_id) systemPrompt += `- contact_id: ${context.contact_id}\n`;
        if (context.job_id) systemPrompt += `- job_id: ${context.job_id}\n`;
        if (context.channel) systemPrompt += `- channel: ${context.channel}\n`;
        if (context.sender) systemPrompt += `- sender: ${context.sender}\n`;
        systemPrompt += `\nCall appropriate context tool(s) immediately before drafting.`;
      }
    }

    let anthropicMessages = [...messages];
    let iterations = 0;
    const MAX_ITER = 6;

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (text: string) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: text })}\n\n`));

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
                model: 'claude-sonnet-4-6',
                max_tokens: 2048,
                stream: true,
                system: systemPrompt,
                tools: TOOLS,
                messages: anthropicMessages,
              }),
            });

            if (!response.ok || !response.body) {
              const errText = response.body ? await response.text() : '';
              console.error('[ask-joe] Anthropic error:', response.status, errText);
              send(`\n[Joe error: API request failed (${response.status}). Check Supabase edge function logs.]`);
              break;
            }

            // Stream Anthropic SSE; accumulate content blocks for tool-use loop
            const blocks: any[] = [];
            const partialInputs = new Map<number, string>();
            let stopReason: string | null = null;
            let evtCount = 0;
            let textDeltaCount = 0;

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const handleLine = (rawLine: string) => {
              let line = rawLine;
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (!line.startsWith('data:')) return;
              const jsonStr = line.slice(line.startsWith('data: ') ? 6 : 5).trim();
              if (!jsonStr || jsonStr === '[DONE]') return;
              let evt: any;
              try { evt = JSON.parse(jsonStr); } catch { return; }
              evtCount++;

              if (evt.type === 'content_block_start') {
                const idx = evt.index;
                const cb = evt.content_block;
                if (cb?.type === 'text') {
                  blocks[idx] = { type: 'text', text: '' };
                } else if (cb?.type === 'tool_use') {
                  blocks[idx] = { type: 'tool_use', id: cb.id, name: cb.name, input: {} };
                  partialInputs.set(idx, '');
                }
              } else if (evt.type === 'content_block_delta') {
                const idx = evt.index;
                const d = evt.delta;
                if (d?.type === 'text_delta' && typeof d.text === 'string') {
                  if (blocks[idx]?.type === 'text') blocks[idx].text += d.text;
                  send(d.text);
                  textDeltaCount++;
                } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
                  partialInputs.set(idx, (partialInputs.get(idx) ?? '') + d.partial_json);
                }
              } else if (evt.type === 'content_block_stop') {
                const idx = evt.index;
                if (blocks[idx]?.type === 'tool_use') {
                  const json = partialInputs.get(idx) ?? '';
                  try { blocks[idx].input = json ? JSON.parse(json) : {}; }
                  catch { blocks[idx].input = {}; }
                }
              } else if (evt.type === 'message_delta') {
                if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
              }
            };

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() ?? '';
              for (const line of lines) handleLine(line);
            }
            if (buffer.length > 0) handleLine(buffer);
            console.log(`[ask-joe] iter ${iterations}: events=${evtCount} text_deltas=${textDeltaCount} stop_reason=${stopReason} blocks=${blocks.filter(Boolean).length}`);

            if (stopReason === 'tool_use') {
              const assistantContent = blocks.filter(Boolean);
              const toolResults: any[] = [];
              for (const block of assistantContent) {
                if (block.type !== 'tool_use') continue;
                let toolOutput: unknown;
                try {
                  if (block.name === 'search_candidates') toolOutput = { candidates: await searchCandidates(supabase, block.input) };
                  else if (block.name === 'semantic_search_candidates') toolOutput = await semanticSearchCandidates(supabase, block.input);
                  else if (block.name === 'get_candidate_context') toolOutput = await getCandidateContext(supabase, block.input.candidate_id);
                  else if (block.name === 'get_contact_context') toolOutput = await getContactContext(supabase, block.input.contact_id);
                  else if (block.name === 'get_job_context') toolOutput = await getJobContext(supabase, block.input.job_id);
                  else toolOutput = { error: `Unknown tool: ${block.name}` };
                  toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(toolOutput) });
                } catch (e: any) {
                  toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: `Error: ${e?.message}`, is_error: true });
                }
              }
              anthropicMessages = [
                ...anthropicMessages,
                { role: 'assistant', content: assistantContent },
                { role: 'user', content: toolResults },
              ];
              continue;
            }
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
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
