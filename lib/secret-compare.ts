import { timingSafeEqual } from "node:crypto"

/**
 * Constant-time check of a presented secret against a configured one, shared by every route that
 * authenticates with a static secret (the `/api/admin/*` family and the cron fallback). Fails
 * closed: a missing or empty configured secret never matches, and an empty presented value never
 * matches. Length is compared first (timingSafeEqual requires equal lengths), which leaks only length.
 */
export function secretMatches(
  presented: string | null | undefined,
  expected: string | null | undefined
): boolean {
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
