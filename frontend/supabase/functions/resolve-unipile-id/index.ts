import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * resolve-unipile-id
 *
 * Given a LinkedIn slug, resolves the Unipile provider_id for that profile.
 * POST { linkedin_slug: "john-doe-123abc" }
 * Returns { unipile_id: "...", provider_id: "..." }
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const unipileApiKey = Deno.env.get("UNIPILE_API_KEY");
    const unipileBaseUrl = Deno.env.get("UNIPILE_BASE_URL");

    if (!unipileApiKey || !unipileBaseUrl) {
      throw new Error("Unipile not configured");
    }

    const { linkedin_slug, account_id } = await req.json();
    if (!linkedin_slug) {
      return new Response(
        JSON.stringify({ error: "linkedin_slug is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Resolve the LinkedIn profile via Unipile's user profile endpoint
    const profileUrl = `${unipileBaseUrl}/api/v1/users/${linkedin_slug}`;
    const headers: Record<string, string> = {
      "X-API-KEY": unipileApiKey,
      "Accept": "application/json",
    };
    if (account_id) {
      headers["X-ACCOUNT-ID"] = account_id;
    }

    const resp = await fetch(profileUrl, { headers });

    if (!resp.ok) {
      const errText = await resp.text();
      return new Response(
        JSON.stringify({ error: `Unipile ${resp.status}: ${errText}` }),
        { status: resp.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const profile = await resp.json();

    return new Response(
      JSON.stringify({
        unipile_id: profile.id ?? null,
        provider_id: profile.provider_id ?? profile.public_identifier ?? null,
        name: profile.name ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
