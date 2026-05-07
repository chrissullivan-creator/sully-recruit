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

  // Reject unauthenticated callers — this endpoint hits Unipile and burns API
  // quota, so allowing anonymous traffic invites abuse. Accept either a
  // Supabase JWT (logged-in user) or the service role key.
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (token !== serviceKey) {
    if (!supabaseUrl || !anonKey) {
      return new Response(JSON.stringify({ error: "Server misconfigured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const client = createClient(supabaseUrl, anonKey);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  try {
    // Prefer v2 credentials; fall back to v1 for orgs that haven't migrated.
    // The v1 endpoint /api/v1/users/{slug} started returning 404 for slugs
    // v2 still resolves, so default to v2 whenever it's configured.
    const v2ApiKey = Deno.env.get("UNIPILE_API_KEY_V2") || Deno.env.get("UNIPILE_API_KEY");
    const v2BaseUrl =
      Deno.env.get("UNIPILE_BASE_V2_URL") ||
      Deno.env.get("UNIPILE_BASE_URL")?.replace(/\/api\/v1\/?$/, "/api/v2");

    if (!v2ApiKey || !v2BaseUrl) {
      throw new Error("Unipile not configured");
    }

    const { linkedin_slug, account_id } = await req.json();
    if (!linkedin_slug) {
      return new Response(
        JSON.stringify({ error: "linkedin_slug is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!account_id) {
      return new Response(
        JSON.stringify({ error: "account_id is required for v2 lookups" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // v2 path: /api/v2/{account_id}/linkedin/users/{slug}
    const base = v2BaseUrl.replace(/\/+$/, "");
    const profileUrl = `${base}/${encodeURIComponent(account_id)}/linkedin/users/${encodeURIComponent(linkedin_slug)}`;
    const headers: Record<string, string> = {
      "X-API-KEY": v2ApiKey,
      "Accept": "application/json",
    };

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
