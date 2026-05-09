/**
 * Drop-in replacement for `import { logger } from "@trigger.dev/sdk/v3"`.
 *
 * Used by helper files in `frontend/src/trigger/lib/` that pre-date the
 * Inngest cutover. Now that the SDK is gone, these helpers run inside
 * Inngest functions (and any future engine) — they need a plain
 * console-backed logger that's safe to import without an orchestrator.
 *
 * Inngest passes its own per-run logger into function handlers, so the
 * code paths that take a logger argument continue to use that. This
 * shim is only for legacy helpers that reach for a global logger.
 */
function fmt(meta: unknown): string {
  if (meta === undefined) return "";
  try {
    return typeof meta === "string" ? meta : JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) =>
    console.info(`[trigger-lib] ${msg}`, fmt(meta)),
  warn: (msg: string, meta?: unknown) =>
    console.warn(`[trigger-lib] ${msg}`, fmt(meta)),
  error: (msg: string, meta?: unknown) =>
    console.error(`[trigger-lib] ${msg}`, fmt(meta)),
  debug: (msg: string, meta?: unknown) =>
    console.debug?.(`[trigger-lib] ${msg}`, fmt(meta)),
};
