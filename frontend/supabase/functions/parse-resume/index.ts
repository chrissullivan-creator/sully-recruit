import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const ANTHROPIC_API_KEY = Deno.env.get("anthropic_api_key") ?? "";

const PARSE_PROMPT = `You are a professional resume parser. Extract structured data from the resume provided. Return ONLY valid JSON, no markdown, no explanation.

Return this exact JSON structure:
{
  "first_name": "First Name",
  "last_name": "Last Name",
  "email": "email@example.com",
  "phone": "phone number",
  "current_company": "Most Recent Company",
  "current_title": "Most Recent Job Title",
  "location": "City, State",
  "linkedin_url": "LinkedIn URL"
}

If a field is not found, use an empty string.`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    let file: File | null = null;
    let filePath = "";
    let fileName = "";

    // Support both FormData (direct upload) and JSON (file_path reference)
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData();
      file = formData.get("file") as File;
      fileName = file?.name || "";
    } else {
      const body = await req.json();
      filePath = body.file_path || "";
      fileName = body.file_name || "";
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader || "" } } }
    );

    const { data: { user } } = await supabase.auth.getUser();
    const userId = user?.id || "anonymous";

    // If we got a file via FormData, upload it
    if (file && !filePath) {
      filePath = `${userId}/${Date.now()}_${file.name}`;
      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);
      const { error: uploadErr } = await supabase.storage
        .from("resumes")
        .upload(filePath, fileBytes, { contentType: file.type });
      if (uploadErr) {
        console.error("Storage upload error:", uploadErr);
      }
    }

    // Get file bytes for Claude — either from the uploaded File or download from storage
    let fileBytes: Uint8Array;
    let mediaType: string;
    if (file) {
      fileBytes = new Uint8Array(await file.arrayBuffer());
      mediaType = file.type || "application/pdf";
    } else if (filePath) {
      const { data: downloadData, error: downloadErr } = await supabase.storage
        .from("resumes")
        .download(filePath);
      if (downloadErr || !downloadData) {
        throw new Error(`Failed to download file: ${downloadErr?.message || "no data"}`);
      }
      fileBytes = new Uint8Array(await downloadData.arrayBuffer());
      mediaType = downloadData.type || "application/pdf";
    } else {
      return new Response(
        JSON.stringify({ error: "No file or file_path provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let parsedResult: any = null;
    let source = "none";

    // Parse with Claude using document/file support
    if (ANTHROPIC_API_KEY) {
      try {
        const base64Data = btoa(
          fileBytes.reduce((data, byte) => data + String.fromCharCode(byte), "")
        );

        // Build content blocks based on file type
        const contentBlocks: any[] = [];
        const lowerName = fileName.toLowerCase();

        if (lowerName.endsWith(".pdf")) {
          contentBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64Data },
          });
        } else if (lowerName.endsWith(".doc") || lowerName.endsWith(".docx")) {
          // For DOC/DOCX, send as text extraction since Claude can't read these natively
          const textContent = new TextDecoder("utf-8", { fatal: false }).decode(fileBytes);
          // Try to extract readable text from the binary
          const readable = textContent.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s{3,}/g, " ").trim();
          if (readable.length > 50) {
            contentBlocks.push({ type: "text", text: `Parse this resume:\n\n${readable.slice(0, 8000)}` });
          } else {
            throw new Error("Could not extract readable text from DOC/DOCX file");
          }
        } else {
          // Text files
          const textContent = new TextDecoder().decode(fileBytes);
          contentBlocks.push({ type: "text", text: `Parse this resume:\n\n${textContent.slice(0, 8000)}` });
        }

        // If we used a document block, add the instruction as a separate text block
        if (contentBlocks.length === 1 && contentBlocks[0].type === "document") {
          contentBlocks.push({ type: "text", text: "Parse this resume and extract the structured data." });
        }

        const claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            max_tokens: 1024,
            system: PARSE_PROMPT,
            messages: [{ role: "user", content: contentBlocks }],
            temperature: 0,
          }),
        });

        if (claudeResp.ok) {
          const claudeData = await claudeResp.json();
          const text = claudeData.content?.[0]?.text || "";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            parsedResult = JSON.parse(jsonMatch[0]);
            source = "claude";
          }
        } else {
          const errText = await claudeResp.text();
          console.error("Claude API error:", errText);
        }
      } catch (e) {
        console.error("Claude parse error:", e);
      }
    }

    // Fallback: return empty fields
    if (!parsedResult) {
      parsedResult = {
        first_name: "", last_name: "", email: "", phone: "",
        current_company: "", current_title: "", location: "", linkedin_url: "",
      };
    }

    return new Response(
      JSON.stringify({
        parsed: parsedResult,
        file_path: filePath,
        file_name: fileName,
        source,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("parse-resume error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
