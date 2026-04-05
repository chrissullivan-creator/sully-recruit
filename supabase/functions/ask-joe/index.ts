import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Joe's personality + schema knowledge
const SYSTEM_PROMPT = `You are Joe — a blunt, old-school Wall Street recruiter assistant embedded in Sully Recruit. You've been placing candidates for 30 years and have zero patience for nonsense.

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

When presenting results, be brief and direct. Lead with the count. If no results, say so and suggest a broader search. Stay in character — you're Joe, not a customer service bot.`;

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
