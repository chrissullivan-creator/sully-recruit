import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const entityType = formData.get("entity_type") as string || "candidate";

    if (!file) {
      return new Response(
        JSON.stringify({ error: "No file provided" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Upload file to Supabase storage
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

    const { error: uploadErr } = await supabase.storage
      .from("resumes")
      .upload(filePath, fileBytes, { contentType: file.type });
    if (uploadErr) {
      console.error("Storage upload error:", uploadErr);
      // Continue anyway - parsing is more important
    }

    // Parse resume with Claude (Anthropic)
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    let parsedResult: any = null;
    let source = "none";

    if (anthropicKey) {
      try {
        const fileBytes = new Uint8Array(arrayBuffer);
        const lowerName = file.name.toLowerCase();
        const contentBlocks: any[] = [];

        if (lowerName.endsWith(".pdf")) {
          // Use Claude's native PDF support
          const base64Data = btoa(String.fromCharCode(...fileBytes));
          contentBlocks.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: base64Data },
          });
          contentBlocks.push({ type: "text", text: "Parse this resume and extract the structured data." });
        } else {
          const fileText = await file.text();
          contentBlocks.push({ type: "text", text: `Parse this resume:\n\n${fileText.slice(0, 8000)}` });
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
            max_tokens: 1024,
            system: "You are a professional resume parser. Extract structured data from resumes. Return ONLY valid JSON with these exact keys: first_name, last_name, email, phone, company, title, location, linkedin_url. If a field is not found, use an empty string. No markdown, no explanation - only the JSON object.",
            messages: [{ role: "user", content: contentBlocks }],
            temperature: 0,
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const text = aiData.content?.[0]?.text || "";
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            parsedResult = {
              first_name: data.first_name || "",
              last_name: data.last_name || "",
              email: data.email || "",
              phone: data.phone || "",
              company: data.company || "",
              title: data.title || "",
              location: data.location || "",
              linkedin_url: data.linkedin_url || "",
            };
            source = "claude";
          }
        }
      } catch (e) {
        console.error("Claude parse error:", e);
      }
    }

    // Fallback if Claude failed or not configured
    if (!parsedResult) {
      parsedResult = {
        first_name: "", last_name: "", email: "", phone: "",
        company: "", title: "", location: "", linkedin_url: "",
      };
    }

    return new Response(
      JSON.stringify({
        parsed: parsedResult,
        file_path: filePath,
        file_name: file.name,
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
