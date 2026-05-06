import { createClient } from "@supabase/supabase-js";
import { logger } from "@trigger.dev/sdk/v3";

/**
 * Server-side Supabase client using service role key.
 * These are the ONLY two env vars needed in Trigger.dev dashboard.
 * All other secrets are read from the app_settings table in Supabase.
 */
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Set these in your Trigger.dev dashboard environment variables.",
    );
  }

  return createClient(url, key);
}

// ─────────────────────────────────────────────────────────────────────────────
// APP SETTINGS — read org-level secrets from app_settings table
// ─────────────────────────────────────────────────────────────────────────────

// In-memory cache to avoid hitting the DB on every task run
const settingsCache: Map<string, { value: string; fetchedAt: number }> = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Read a secret from the app_settings table.
 * Caches in memory for 5 minutes to avoid repeated DB hits.
 */
export async function getAppSetting(key: string): Promise<string> {
  // Check cache first
  const cached = settingsCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .single();

  if (data?.value) {
    settingsCache.set(key, { value: data.value, fetchedAt: Date.now() });
    return data.value;
  }

  // Fallback: check environment variable (e.g. set in Trigger.dev dashboard)
  const envValue = process.env[key];
  if (envValue) {
    logger.warn(`app_settings.${key} is empty — falling back to env var`);
    settingsCache.set(key, { value: envValue, fetchedAt: Date.now() });
    return envValue;
  }

  throw new Error(
    `Missing app setting: ${key}. Add it in Supabase → Table Editor → app_settings, or set it as an environment variable in Trigger.dev.`,
  );
}

/**
 * Batch-read multiple settings at once.
 */
export async function getAppSettings(...keys: string[]): Promise<Record<string, string>> {
  // Check if all are cached
  const result: Record<string, string> = {};
  const missingKeys: string[] = [];

  for (const key of keys) {
    const cached = settingsCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      result[key] = cached.value;
    } else {
      missingKeys.push(key);
    }
  }

  if (missingKeys.length === 0) return result;

  // Fetch missing keys from DB
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("app_settings")
    .select("key, value")
    .in("key", missingKeys);

  if (error) {
    throw new Error(`Failed to read app_settings: ${error.message}`);
  }

  for (const row of data || []) {
    if (row.value) {
      result[row.key] = row.value;
      settingsCache.set(row.key, { value: row.value, fetchedAt: Date.now() });
    }
  }

  // Check all requested keys are present, fall back to env vars
  for (const key of keys) {
    if (!result[key]) {
      const envValue = process.env[key];
      if (envValue) {
        logger.warn(`app_settings.${key} is empty — falling back to env var`);
        result[key] = envValue;
        settingsCache.set(key, { value: envValue, fetchedAt: Date.now() });
      } else {
        throw new Error(
          `Missing app setting: ${key}. Add it in Supabase → Table Editor → app_settings, or set it as an environment variable in Trigger.dev.`,
        );
      }
    }
  }

  return result;
}

/**
 * Get Anthropic API key from app_settings.
 */
export async function getAnthropicKey(): Promise<string> {
  return getAppSetting("ANTHROPIC_API_KEY");
}

/**
 * Get OpenAI API key from app_settings. Used as a fallback parser when
 * Anthropic is over quota / rate-limited / down. Returns empty string
 * (not an error) so callers can detect "fallback unavailable" without
 * a try/catch.
 */
export async function getOpenAIKey(): Promise<string> {
  try {
    return await getAppSetting("OPENAI_API_KEY");
  } catch {
    return "";
  }
}

/**
 * Get Eden AI API key from app_settings. Used as a deeper fallback for
 * resume parsing — Eden's `ocr/resume_parser` providers (affinda etc.)
 * handle scanned / image-only PDFs that text-extraction can't read.
 * Returns empty string when not configured.
 */
export async function getEdenAIKey(): Promise<string> {
  try {
    return await getAppSetting("EDEN_AI_API_KEY");
  } catch {
    return "";
  }
}

/**
 * Get Voyage AI API key from app_settings.
 */
export async function getVoyageKey(): Promise<string> {
  return getAppSetting("VOYAGE_API_KEY");
}

/**
 * Get Unipile base URL from app_settings.
 * Centralised so the DSN is configured once, not hardcoded in every file.
 */
export async function getUnipileBaseUrl(): Promise<string> {
  return getAppSetting("UNIPILE_BASE_URL");
}

/**
 * Get Microsoft Graph app credentials from app_settings.
 */
export async function getMicrosoftGraphCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
  tenantId: string;
}> {
  const settings = await getAppSettings(
    "MICROSOFT_GRAPH_CLIENT_ID",
    "MICROSOFT_GRAPH_CLIENT_SECRET",
    "MICROSOFT_GRAPH_TENANT_ID",
  );

  return {
    clientId: settings.MICROSOFT_GRAPH_CLIENT_ID,
    clientSecret: settings.MICROSOFT_GRAPH_CLIENT_SECRET,
    tenantId: settings.MICROSOFT_GRAPH_TENANT_ID,
  };
}
