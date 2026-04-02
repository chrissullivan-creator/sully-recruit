import { createClient } from "@supabase/supabase-js";

/**
 * Server-side Supabase client using service role key.
 * Used by Trigger.dev tasks running on Trigger.dev cloud.
 * Env vars are set in the Trigger.dev dashboard, NOT Vite's VITE_* prefix.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
      "Set these in your Trigger.dev dashboard environment variables."
    );
  }

  return createClient(url, key);
}

/**
 * Get Anthropic API key with fallback for lowercase variant
 * (Supabase secrets were stored lowercase historically)
 */
export function getAnthropicKey(): string {
  const key = process.env.ANTHROPIC_API_KEY ?? process.env.anthropic_api_key ?? "";
  if (!key) {
    throw new Error("Missing ANTHROPIC_API_KEY environment variable.");
  }
  return key;
}

/**
 * Get Voyage AI API key
 */
export function getVoyageKey(): string {
  const key = process.env.VOYAGE_API_KEY ?? "";
  if (!key) {
    throw new Error("Missing VOYAGE_API_KEY environment variable.");
  }
  return key;
}
