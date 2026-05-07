/**
 * Unified AI cascade: Gemini → Claude → OpenAI.
 *
 * Drops in anywhere we call an LLM. Tries each provider whose key is
 * supplied, in the listed order. On a fallback-able failure (credit
 * balance, 429, 401/403, model overload, etc.) it falls through to
 * the next provider; any other error is re-thrown so the caller's
 * retry policy still applies.
 *
 * Usable from both Vercel serverless functions and Trigger.dev tasks —
 * both run Node 20 with global fetch.
 *
 * Limitations:
 *   - When `userContent` includes PDF/image document blocks (the
 *     Anthropic input shape), only Claude can be tried; Gemini and
 *     OpenAI stages are skipped.
 *   - Each stage is opt-in by passing the corresponding key. If only
 *     one key is set, the helper effectively becomes a single-provider
 *     wrapper with no fallback.
 */

export interface CallAIOptions {
  /** Gemini API key. Tried first when set. */
  geminiKey?: string;
  /** Anthropic API key. Tried second (or first if no geminiKey). */
  anthropicKey?: string;
  /** OpenAI API key. Tried last. */
  openaiKey?: string;
  systemPrompt: string;
  /**
   * Either a plain string (user message) or an array of Anthropic-shaped
   * content blocks. Documents/images skip Gemini + OpenAI fallbacks.
   */
  userContent: string | any[];
  /** Anthropic model — default 'claude-sonnet-4-20250514'. */
  model?: string;
  /** Gemini model — default 'gemini-2.5-flash'. */
  geminiModel?: string;
  /** OpenAI fallback model — default 'gpt-4o-mini'. */
  fallbackModel?: string;
  /** Default 1024. */
  maxTokens?: number;
  /** Default 0. */
  temperature?: number;
  /** When true, JSON-shaped output is requested (Gemini + OpenAI honor
   *  this directly; Anthropic relies on the system prompt). */
  jsonOutput?: boolean;
}

export interface CallAIResult {
  text: string;
  /** Which provider actually produced the answer. */
  via: "gemini" | "claude" | "openai";
}

const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

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

export async function callAIWithFallback(opts: CallAIOptions): Promise<CallAIResult> {
  const isText = userContentIsTextOnly(opts.userContent);
  let lastError: unknown = null;

  // ── Stage 1: Gemini (only when text-only — Gemini doesn't speak the
  //               Anthropic doc-block shape we sometimes pass)
  if (opts.geminiKey && isText) {
    try {
      const text = await tryGemini(opts);
      return { text, via: "gemini" };
    } catch (err) {
      lastError = err;
      if (!isFallbackable(err)) throw err;
    }
  }

  // ── Stage 2: Claude
  if (opts.anthropicKey) {
    try {
      const text = await tryClaude(opts);
      return { text, via: "claude" };
    } catch (err) {
      lastError = err;
      if (!isFallbackable(err)) throw err;
    }
  }

  // ── Stage 3: OpenAI (text-only — same caveat as Gemini for docs)
  if (opts.openaiKey && isText) {
    try {
      const text = await tryOpenAI(opts);
      return { text, via: "openai" };
    } catch (err) {
      lastError = err;
      throw err;
    }
  }

  throw lastError ?? new Error("callAIWithFallback: no provider keys supplied");
}
