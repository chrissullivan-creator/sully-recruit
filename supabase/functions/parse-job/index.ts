import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SYSTEM_PROMPT = `You are a professional job posting parser for a recruiting firm. Extract structured data from job postings.
Return ONLY valid JSON with these exact keys: title, company_name, location, compensation, description.
The description should be formatted as clean HTML with <ul>/<li> for bullet points, <strong> for emphasis, and <p> for paragraphs.
Preserve the structure and details of the original job description including responsibilities, requirements, qualifications, and benefits.
If a field is not found, use an empty string. No markdown, no explanation — only the JSON object.`;

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function callClaude(contentBlocks: any[]): Promise<any> {
  const anthropicKey =
    Deno.env.get("ANTHROPIC_API_KEY") ??
    Deno.env.get("anthropic_api_key") ??
    "";

  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: contentBlocks }],
      temperature: 0,
    }),
  });

  if (!aiResp.ok) {
    const errText = await aiResp.text();
    console.error("Claude API error:", errText);
    throw new Error(`Claude API returned ${aiResp.status}`);
  }

  const aiData = await aiResp.json();
  const text = aiData.content?.[0]?.text || "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Could not parse JSON from Claude response");
  }

  return JSON.parse(jsonMatch[0]);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const contentType = req.headers.get("content-type") || "";

    // ── Mode A: URL parsing (JSON body) ──────────────────────────────
    if (contentType.includes("application/json")) {
      const { url } = await req.json();
      if (!url) {
        return new Response(
          JSON.stringify({ error: "No URL provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Fetch the page
      const pageResp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; SullyRecruit/1.0)",
          "Accept": "text/html,application/xhtml+xml",
        },
      });

      if (!pageResp.ok) {
        return new Response(
          JSON.stringify({ error: `Failed to fetch URL: ${pageResp.status}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const html = await pageResp.text();
      const pageText = stripHtml(html).slice(0, 12000);

      const contentBlocks = [
        { type: "text", text: `Parse this job posting from the following webpage content:\n\n${pageText}` },
      ];

      const parsed = await callClaude(contentBlocks);

      return new Response(
        JSON.stringify({
          parsed: {
            title: parsed.title || "",
            company_name: parsed.company_name || "",
            location: parsed.location || "",
            compensation: parsed.compensation || "",
            description: parsed.description || "",
          },
          source: "claude",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Mode B: Document parsing (FormData) ──────────────────────────
    if (contentType.includes("multipart/form-data")) {
      const authHeader = req.headers.get("Authorization");
      const formData = await req.formData();
      const file = formData.get("file") as File;

      if (!file) {
        return new Response(
          JSON.stringify({ error: "No file provided" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Upload to storage
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader || "" } } }
      );

      const { data: { user } } = await supabase.auth.getUser();
      const userId = user?.id || "anonymous";
      const filePath = `${userId}/${Date.now()}_${file.name}`;

      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);

      // Try uploading but don't block on failure
      await supabase.storage
        .from("job-docs")
        .upload(filePath, fileBytes, { contentType: file.type })
        .catch((e: any) => console.error("Storage upload error:", e));

      // Chunked base64 encoding (safe for large files — avoids max argument limit)
      function toBase64(bytes: Uint8Array): string {
        const chunks: string[] = [];
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
        }
        return btoa(chunks.join(""));
      }

      // Build content blocks for Claude
      const lowerName = file.name.toLowerCase();
      const contentBlocks: any[] = [];

      if (lowerName.endsWith(".pdf")) {
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: toBase64(fileBytes) },
        });
        contentBlocks.push({
          type: "text",
          text: "Parse this job posting document and extract the structured data.",
        });
      } else if (lowerName.endsWith(".docx") || lowerName.endsWith(".doc")) {
        // DOCX/DOC: send as base64 document — Claude can handle Office formats
        const mediaType = lowerName.endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "application/msword";
        contentBlocks.push({
          type: "document",
          source: { type: "base64", media_type: mediaType, data: toBase64(fileBytes) },
        });
        contentBlocks.push({
          type: "text",
          text: "Parse this job posting document and extract the structured data.",
        });
      } else {
        // .txt and other plain text files
        const fileText = new TextDecoder().decode(fileBytes);
        contentBlocks.push({
          type: "text",
          text: `Parse this job posting document:\n\n${fileText.slice(0, 12000)}`,
        });
      }

      const parsed = await callClaude(contentBlocks);

      return new Response(
        JSON.stringify({
          parsed: {
            title: parsed.title || "",
            company_name: parsed.company_name || "",
            location: parsed.location || "",
            compensation: parsed.compensation || "",
            description: parsed.description || "",
          },
          file_path: filePath,
          file_name: file.name,
          source: "claude",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unsupported content type. Use application/json for URL or multipart/form-data for file upload." }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("parse-job error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
