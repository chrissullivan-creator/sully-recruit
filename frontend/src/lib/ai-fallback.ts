/**
 * Unified AI cascade. Default order: Claude → OpenAI → Gemini →
 * OpenRouter, overridable per call via `order` (resume parsing runs
 * OpenAI-first — see RESUME_PARSE_ORDER).
 *
 * Drops in anywhere we call an LLM. Tries each provider whose key is
 * supplied, in `order`. On a fallback-able failure (credit balance,
 * 429, 401/403, model overload, etc.) it falls through to the next
 * provider; any other error is re-thrown so the caller's retry policy
 * still applies.
 *
 * All AI surfaces (resume parsing, drafting, chat, sentiment, matching)
 * pass all four keys. Most lead with Claude — the strongest model for
 * recruiting-specific reasoning, structured-extraction, and tone-matching
 * work, and the only one that natively handles PDF/image doc blocks the
 * other providers can't accept. Resume parsing overrides this to lead
 * with OpenAI (RESUME_PARSE_ORDER).
 *
 * Usable from both Vercel serverless functions and Trigger.dev tasks —
 * both run Node 20 with global fetch.
 *
 * Limitations:
 *   - When `userContent` includes PDF/image document blocks (the
 *     Anthropic input shape), only Claude can be tried; Gemini, OpenAI,
 *     and OpenRouter stages are skipped.
 *   - Each stage is opt-in by passing the corresponding key. If only
 *     one key is set, the helper effectively becomes a single-provider
 *     wrapper with no fallback.
 */

export type AIProvider = "claude" | "openai" | "gemini" | "openrouter";

export interface CallAIOptions {
  /** Anthropic API key. Tried first by default (see `order`). */
  anthropicKey?: string;
  /** OpenAI API key. Tried second by default. */
  openaiKey?: string;
  /** Gemini API key. Tried third by default. */
  geminiKey?: string;
  /** OpenRouter API key. Tried last by default — gateway to many providers
   *  in one account, used as the final escape hatch when every other
   *  provider fails open. */
  openRouterKey?: string;
  /**
   * Provider order. Defaults to ['claude','openai','gemini','openrouter'].
   * Each provider still runs only when its key is supplied; non-text
   * (PDF/image) content always routes to Claude regardless of order.
   */
  order?: AIProvider[];
  systemPrompt: string;
  /**
   * Either a plain string (user message) or an array of Anthropic-shaped
   * content blocks. Documents/images skip the OpenAI, Gemini, and
   * OpenRouter fallbacks.
   */
  userContent: string | any[];
  /** Anthropic model — default 'claude-sonnet-4-6'. */
  model?: string;
  /** Gemini model — default 'gemini-2.5-flash'. */
  geminiModel?: string;
  /** OpenAI fallback model — default 'gpt-4o-mini'. */
  fallbackModel?: string;
  /** OpenRouter fallback model slug — default 'openai/gpt-4o-mini'. Any
   *  OpenAI-compatible chat model OpenRouter routes to is fine. */
  openRouterModel?: string;
  /** Default 1024. */
  maxTokens?: number;
  /** Default 0. */
  temperature?: number;
  /** When true, JSON-shaped output is requested (Gemini + OpenAI +
   *  OpenRouter honor this directly; Anthropic relies on the system
   *  prompt). */
  jsonOutput?: boolean;
}

export interface CallAIResult {
  text: string;
  /** Which provider actually produced the answer. */
  via: AIProvider;
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";

/**
 * Default cascade order. OpenRouter is intentionally OFF the chain: that
 * account has no credits ("never purchased credits"), so as the last fallback
 * it only ever returned a 402 that masked the real upstream error and spammed
 * alerts. Callers may still pass openRouterKey; re-add "openrouter" here (and in
 * RESUME_PARSE_ORDER) if the account is ever funded.
 */
const DEFAULT_ORDER: AIProvider[] = ["claude", "openai", "gemini"];

/**
 * Resume parsing leads with OpenAI, then falls back to Claude → Gemini.
 * Pass as `order` from the resume-parsing call sites.
 */
export const RESUME_PARSE_ORDER: AIProvider[] = ["openai", "claude", "gemini"];

const FALLBACK_REGEX =
  /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key|overloaded|quota|exhausted|unavailable|503|500/i;

function isFallbackable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return FALLBACK_REGEX.test(msg);
}

function userContentIsTextOnly(c: CallAIOptions["userContent"]): c is string {
  return typeof c === "string";
}

async function tryGemini(opts: CallAIOptions): Promise<string> {
  // Gemini wants the system prompt as a top-level systemInstruction
  // and the user content as parts on a single user-role message.
  const userText = userContentIsTextOnly(opts.userContent)
    ? opts.userContent
    : (opts.userContent as any[])
        .filter((b) => b?.type === "text")
        .map((b) => b.text)
        .join("\n");

  const model = opts.geminiModel || DEFAULT_GEMINI_MODEL;
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` +
    `?key=${encodeURIComponent(opts.geminiKey!)}`;

  const body: any = {
    systemInstruction: { parts: [{ text: opts.systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
    },
  };
  if (opts.jsonOutput) body.generationConfig.responseMimeType = "application/json";

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 400)}`);
  }
  const data = await resp.json();
  const text =
    (data.candidates?.[0]?.content?.parts || [])
      .map((p: any) => p.text || "")
      .join("") || "";
  if (!text) throw new Error("Gemini returned no text content");
  return text;
}

async function tryClaude(opts: CallAIOptions): Promise<string> {
  const userBlocks = userContentIsTextOnly(opts.userContent)
    ? [{ type: "text", text: opts.userContent }]
    : opts.userContent;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": opts.anthropicKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_CLAUDE_MODEL,
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 0,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: userBlocks }],
    }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const text =
    (data.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("") || "";
  return text;
}

async function tryOpenAI(opts: CallAIOptions): Promise<string> {
  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userContent as string },
  ];
  const body: any = {
    model: opts.fallbackModel || DEFAULT_OPENAI_MODEL,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1024,
    messages,
  };
  if (opts.jsonOutput) body.response_format = { type: "json_object" };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.openaiKey!}`,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

async function tryOpenRouter(opts: CallAIOptions): Promise<string> {
  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userContent as string },
  ];
  const body: any = {
    model: opts.openRouterModel || DEFAULT_OPENROUTER_MODEL,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 1024,
    messages,
  };
  if (opts.jsonOutput) body.response_format = { type: "json_object" };

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.openRouterKey!}`,
      // Optional but recommended by OpenRouter for analytics + rate-limit grouping.
      "HTTP-Referer": "https://www.sullyrecruit.app",
      "X-Title": "Sully Recruit",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

export async function callAIWithFallback(opts: CallAIOptions): Promise<CallAIResult> {
  const isText = userContentIsTextOnly(opts.userContent);
  let lastError: unknown = null;

  // Per-provider config. `textOnly` providers are skipped when the user
  // content carries PDF/image doc blocks — only Claude accepts those.
  const providers: Record<
    AIProvider,
    { key: string | undefined; textOnly: boolean; run: (o: CallAIOptions) => Promise<string> }
  > = {
    claude: { key: opts.anthropicKey, textOnly: false, run: tryClaude },
    openai: { key: opts.openaiKey, textOnly: true, run: tryOpenAI },
    gemini: { key: opts.geminiKey, textOnly: true, run: tryGemini },
    openrouter: { key: opts.openRouterKey, textOnly: true, run: tryOpenRouter },
  };

  for (const name of opts.order ?? DEFAULT_ORDER) {
    const provider = providers[name];
    if (!provider?.key) continue;
    if (provider.textOnly && !isText) continue;
    try {
      const text = await provider.run(opts);
      return { text, via: name };
    } catch (err) {
      lastError = err;
      if (!isFallbackable(err)) throw err;
    }
  }

  throw lastError ?? new Error("callAIWithFallback: no provider keys supplied");
}
