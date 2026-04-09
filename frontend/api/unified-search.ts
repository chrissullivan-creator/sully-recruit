import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

/**
 * POST /api/unified-search
 * Multi-turn AI chat that searches across all data (candidates, contacts, jobs, notes, messages).
 * Streams SSE responses with data.content chunks.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const write = (content: string) => {
    res.write(`data: ${JSON.stringify({ content })}\n\n`);
  };
  const writeError = (error: string) => {
    res.write(`data: ${JSON.stringify({ error })}\n\n`);
  };

  try {
    const { query, messages } = req.body;

    if (!query) {
      writeError("Missing query");
      return res.end();
    }

    const supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );

    // Search across multiple tables in parallel
    const keywords = query.split(/\s+/).slice(0, 3);
    const likeFilter = keywords.map((k: string) => `%${k}%`);

    const [candidateRes, contactRes, jobRes, noteRes] = await Promise.all([
      // Candidates
      supabase
        .from("candidates")
        .select("id, full_name, title, company, location, status, email, phone")
        .or(keywords.map((k: string) => `full_name.ilike.%${k}%,title.ilike.%${k}%,company.ilike.%${k}%,email.ilike.%${k}%`).join(","))
        .limit(15),

      // Contacts
      supabase
        .from("contacts")
        .select("id, full_name, title, company_name, email, phone")
        .or(keywords.map((k: string) => `full_name.ilike.%${k}%,title.ilike.%${k}%,company_name.ilike.%${k}%,email.ilike.%${k}%`).join(","))
        .limit(15),

      // Jobs
      supabase
        .from("jobs")
        .select("id, title, company_name, location, status")
        .or(keywords.map((k: string) => `title.ilike.%${k}%,company_name.ilike.%${k}%`).join(","))
        .limit(10),

      // Notes (search body text)
      supabase
        .from("notes")
        .select("id, candidate_id, contact_id, body, created_at")
        .or(keywords.map((k: string) => `body.ilike.%${k}%`).join(","))
        .order("created_at", { ascending: false })
        .limit(10),
    ]);

    // Build context
    const sections: string[] = [];

    if (candidateRes.data?.length) {
      sections.push(
        `## Candidates (${candidateRes.data.length} found)\n` +
        candidateRes.data
          .map((c) => `- **${c.full_name}** | ${c.title || "?"} at ${c.company || "?"} | ${c.location || "?"} | Status: ${c.status} | ${c.email || "no email"} | ${c.phone || "no phone"}`)
          .join("\n"),
      );
    }

    if (contactRes.data?.length) {
      sections.push(
        `## Contacts (${contactRes.data.length} found)\n` +
        contactRes.data
          .map((c) => `- **${c.full_name}** | ${c.title || "?"} at ${c.company_name || "?"} | ${c.email || "no email"} | ${c.phone || "no phone"}`)
          .join("\n"),
      );
    }

    if (jobRes.data?.length) {
      sections.push(
        `## Jobs (${jobRes.data.length} found)\n` +
        jobRes.data
          .map((j) => `- **${j.title}** at ${j.company_name || "?"} | ${j.location || "?"} | Status: ${j.status}`)
          .join("\n"),
      );
    }

    if (noteRes.data?.length) {
      sections.push(
        `## Notes (${noteRes.data.length} found)\n` +
        noteRes.data
          .map((n) => `- ${n.body?.slice(0, 200)}... (${n.created_at?.slice(0, 10)})`)
          .join("\n"),
      );
    }

    const dbContext = sections.length
      ? sections.join("\n\n")
      : "No results found in the database for this query.";

    // Build conversation
    const systemPrompt = `You are Joe, the AI recruiting assistant at Sully Recruit (The Emerald Recruiting Group). You help search across the entire CRM — candidates, contacts, jobs, and notes.

When answering:
- Be specific — include names, titles, companies, contact info
- Cross-reference data when useful (e.g. a contact at a company that has open jobs)
- Be concise and direct
- If nothing matches, suggest alternative search terms

## Database Search Results

${dbContext}`;

    const conversationMessages = (messages || [])
      .filter((m: any) => m.role === "user" || m.role === "assistant")
      .slice(-10)
      .map((m: any) => ({ role: m.role, content: m.content }));

    if (!conversationMessages.length || conversationMessages[conversationMessages.length - 1].role !== "user") {
      conversationMessages.push({ role: "user", content: query });
    }

    // Stream Claude response
    const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages: conversationMessages,
      }),
    });

    if (!claudeResp.ok) {
      const errText = await claudeResp.text();
      writeError(`Claude API error: ${errText}`);
      return res.end();
    }

    const reader = claudeResp.body?.getReader();
    if (!reader) {
      writeError("No response stream");
      return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === "content_block_delta" && event.delta?.text) {
              write(event.delta.text);
            }
          } catch {
            // skip
          }
        }
      }
    }

    res.end();
  } catch (err: any) {
    console.error("unified-search error:", err.message);
    writeError(err.message);
    res.end();
  }
}
