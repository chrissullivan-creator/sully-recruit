/**
 * Unified Claude → OpenAI fallback helper.
 *
 * Drops in anywhere we call the Anthropic Messages API. On a fallback-able
 * Anthropic failure (credit balance exhausted, 429 rate limit, 401/403
 * auth, invalid key), automatically retries against OpenAI's chat
 * completions API with an equivalent prompt. Anything else (5xx, parse
 * error, malformed input) re-throws so the caller's normal retry policy
 * still applies.
 *
 * Usable from both Vercel serverless functions and Trigger.dev tasks —
 * both run Node 20 with global fetch.
 *
 * Limitations:
 *   - When `userContent` includes PDF/image document blocks, the
 *     fallback is skipped and the original error re-thrown. OpenAI's
 *     equivalent input shape is different enough that we'd rather let
 *     the caller decide whether to extract text first or wait for
 *     Anthropic to recover.
 */

export interface CallAIOptions {
  anthropicKey: string;
  /** Optional. Without it, fallback is disabled. */
  openaiKey?: string;
  systemPrompt: string;
  /**
   * Either a plain string (user message) or an array of Anthropic-shaped
   * content blocks. Documents/images disable the OpenAI fallback path.
   */
  userContent: string | any[];
  /** Default 'claude-sonnet-4-6'. */
  model?: string;
  /** Default 'gpt-4o-mini' on fallback. */
  fallbackModel?: string;
  /** Default 1024. */
  maxTokens?: number;
  /** Default 0. */
  temperature?: number;
  /** When true, OpenAI is instructed to return JSON. Anthropic isn't,
   *  but most callers prompt for JSON in the system text already. */
  jsonOutput?: boolean;
}

export interface CallAIResult {
  text: string;
  /** Which provider actually produced the answer. */
  via: "claude" | "openai";
}

const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-20250514";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

const FALLBACK_REGEX =
  /credit balance|insufficient|429|rate.?limit|401|403|invalid.?api.?key|overloaded/i;

function isFallbackable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return FALLBACK_REGEX.test(msg);
}

function userContentIsTextOnly(c: CallAIOptions["userContent"]): c is string {
  return typeof c === "string";
}

export async function callAIWithFallback(opts: CallAIOptions): Promise<CallAIResult> {
  const claudeModel = opts.model || DEFAULT_CLAUDE_MODEL;
  const fallbackModel = opts.fallbackModel || DEFAULT_OPENAI_MODEL;
  const maxTokens = opts.maxTokens ?? 1024;
  const temperature = opts.temperature ?? 0;

  // Try Claude first.
  let claudeError: unknown = null;
  try {
    const userBlocks = userContentIsTextOnly(opts.userContent)
      ? [{ type: "text", text: opts.userContent }]
      : opts.userContent;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: claudeModel,
        max_tokens: maxTokens,
        temperature,
        system: opts.systemPrompt,
        messages: [{ role: "user", content: userBlocks }],
      }),
    });

    if (!resp.ok) {
      throw new Error(`Anthropic ${resp.status}: ${await resp.text()}`);
    }
    const data = await resp.json();
    const text =
      (data.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("") || "";
    return { text, via: "claude" };
  } catch (err) {
    claudeError = err;
  }

  // Decide whether to fall back.
  const canFallback =
    !!opts.openaiKey &&
    isFallbackable(claudeError) &&
    userContentIsTextOnly(opts.userContent);

  if (!canFallback) {
    throw claudeError;
  }

  // OpenAI path.
  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userContent as string },
  ];

  const body: any = {
    model: fallbackModel,
    temperature,
    max_tokens: maxTokens,
    messages,
  };
  if (opts.jsonOutput) body.response_format = { type: "json_object" };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.openaiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI fallback ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || "";
  return { text, via: "openai" };
}
