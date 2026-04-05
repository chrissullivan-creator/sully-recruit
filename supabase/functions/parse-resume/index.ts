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

    // Try Eden AI first for structured parsing
    const edenApiKey = Deno.env.get("Eden_AI");
    let edenResult: any = null;
    let source = "none";

    if (edenApiKey) {
      try {
        const edenForm = new FormData();
        edenForm.append("providers", "affinda");
        edenForm.append("file", file);

        const edenResp = await fetch("https://api.edenai.run/v2/ocr/resume_parser", {
          method: "POST",
          headers: { Authorization: `Bearer ${edenApiKey}` },
          body: edenForm,
        });

        if (edenResp.ok) {
          const edenData = await edenResp.json();
          const affinda = edenData?.affinda?.extracted_data;
          if (affinda) {
            const name = affinda.personal_infos?.name || {};
            const address = affinda.personal_infos?.address || {};
            const phones = affinda.personal_infos?.phones || [];
            const mails = affinda.personal_infos?.mails || [];
            const urls = affinda.personal_infos?.urls || [];
            const experiences = affinda.work_experience?.entries || [];
            const latestJob = experiences[0] || {};

            const linkedinUrl = urls.find((u: string) =>
              typeof u === "string" && u.toLowerCase().includes("linkedin")
            ) || "";

            edenResult = {
              first_name: name.first_name || "",
              last_name: name.last_name || "",
              email: mails[0] || "",
              phone: phones[0] || "",
              current_company: latestJob.company || "",
              current_title: latestJob.title || "",
              location: [address.city, address.region, address.country]
                .filter(Boolean)
                .join(", "),
              linkedin_url: linkedinUrl,
              raw_text: affinda.raw_text || "",
            };
            source = "eden_ai";
          }
        }
      } catch (e) {
        console.error("Eden AI error:", e);
      }
    }

    // If Eden AI failed or not configured, fall back to Ask Joe (OpenAI) for text files only
    if (!edenResult && file.type.includes('text')) {
      const fileText = await file.text();
      const openaiKey = Deno.env.get("OPENAI_API_KEY");
      const lovableKey = Deno.env.get("LOVABLE_API_KEY");

      const apiKey = openaiKey || lovableKey;
      if (apiKey) {
        const apiUrl = openaiKey
          ? "https://api.openai.com/v1/chat/completions"
          : "https://ai.gateway.lovable.dev/v1/chat/completions";
        const model = openaiKey ? "gpt-4.1" : "google/gemini-3-flash-preview";

        const aiResp = await fetch(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "system",
                content: "You are Joe, a resume parsing assistant. Extract structured data from resumes. Return ONLY valid JSON with these exact keys: first_name, last_name, email, phone, current_company, current_title, location, linkedin_url. If a field is not found, use an empty string. No markdown, no explanation - only the JSON object.",
              },
              {
                role: "user",
                content: `Parse this resume:\n\n${fileText.slice(0, 6000)}`,
              },
            ],
            temperature: 0,
          }),
        });

        if (aiResp.ok) {
          const aiData = await aiResp.json();
          const content = aiData.choices?.[0]?.message?.content || "";
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const data = JSON.parse(jsonMatch[0]);
            edenResult = {
              first_name: data.first_name || "",
              last_name: data.last_name || "",
              email: data.email || "",
              phone: data.phone || "",
              current_company: data.current_company || "",
              current_title: data.current_title || "",
              location: data.location || "",
              linkedin_url: data.linkedin_url || "",
              raw_text: fileText.slice(0, 50000),
            };
            source = "ask_joe";
          }
        }
      }
    }

    // Fallback if everything failed
    if (!edenResult) {
      const fileText = await file.text();
      edenResult = {
        first_name: "", last_name: "", email: "", phone: "",
        current_company: "", current_title: "", location: "", linkedin_url: "",
        raw_text: fileText.slice(0, 50000),
      };
    }

    return new Response(
      JSON.stringify({
        parsed: edenResult,
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
