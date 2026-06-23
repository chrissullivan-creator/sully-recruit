import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for secrets / bearer tokens.
 *
 * Plain `a === b` short-circuits on the first differing byte, which leaks how
 * much of a guess is correct via response timing. We hash both sides to a
 * fixed 32-byte digest first so:
 *   - timingSafeEqual never throws on a length mismatch, and
 *   - the comparison doesn't leak the secret's length either.
 *
 * Not a defense against an attacker who can already read the secret — just
 * removes the timing side-channel from the comparison itself.
 */
export function safeEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  const ha = createHash("sha256").update(String(a ?? "")).digest();
  const hb = createHash("sha256").update(String(b ?? "")).digest();
  return timingSafeEqual(ha, hb);
}
