/**
 * Validation for the post-login `callbackUrl` search parameter.
 *
 * `proxy.ts` now preserves the URL an anonymous visitor was trying to reach and
 * hands it to `/login` as `?callbackUrl=…`, because an OAuth authorize request
 * carries `client_id`, `redirect_uri`, `state`, `code_challenge`, `resource`
 * and `scope` in its query string and dropping them breaks the flow for every
 * not-currently-signed-in user (the common case — MCP clients open a fresh
 * browser).
 *
 * That parameter is attacker-controllable, so passing it through unvalidated
 * would be an open redirect. Everything here exists to guarantee one property:
 * **the returned value is a same-origin, root-relative path, or the fallback.**
 * Never `//evil.com`, never `https://evil.com`, never `/\evil.com`.
 */

/** Where login lands when no valid `callbackUrl` was supplied. */
export const DEFAULT_POST_LOGIN_PATH = "/dashboard"

/**
 * Opaque origin used only to resolve the candidate for inspection. It is never
 * emitted — if a candidate resolves anywhere other than here, it was not
 * relative and is rejected.
 */
const VALIDATION_ORIGIN = "https://callback-url-validation.invalid"

/** Long enough for a full OAuth authorize query string, short enough to bound. */
const MAX_LENGTH = 2048

/** C0 controls plus DEL — the characters browsers silently strip while parsing. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Normalises `raw` to a safe root-relative path, falling back when it is
 * absent, malformed, or points anywhere but this origin.
 *
 * Accepts `string[]` because Next's `searchParams` yields one for a repeated
 * key; a repeated `callbackUrl` is ambiguous, so it takes the fallback rather
 * than guessing which copy the user meant.
 */
export function safeCallbackUrl(
  raw: string | string[] | null | undefined,
  fallback: string = DEFAULT_POST_LOGIN_PATH,
): string {
  if (typeof raw !== "string") return fallback
  if (raw.length === 0 || raw.length > MAX_LENGTH) return fallback

  // Browsers strip control characters (including tab and newline) while parsing
  // a URL, so "/\t/evil.com" and friends must never get as far as the parser.
  if (CONTROL_CHARACTERS.test(raw)) return fallback
  // A backslash is normalised to "/" in a special-scheme URL, which turns
  // "/\evil.com" into the protocol-relative "//evil.com". No legitimate
  // relative path contains a raw backslash — an encoded %5C is unaffected.
  if (raw.includes("\\")) return fallback
  // Root-relative only. This alone rejects "https://evil.com",
  // "//evil.com", "%2F%2Fevil.com" and every scheme-bearing form.
  if (!isRootRelative(raw)) return fallback

  let resolved: URL
  try {
    resolved = new URL(raw, VALIDATION_ORIGIN)
  } catch {
    return fallback
  }
  if (resolved.origin !== VALIDATION_ORIGIN) return fallback

  // Re-serialise from the parsed form so nothing survives that the URL parser
  // would have rewritten, then re-apply the structural check to the result.
  // `search` and `hash` keep their percent-encoding, so an authorize URL's
  // `redirect_uri=http%3A%2F%2F127.0.0.1%2Fcallback` round-trips intact.
  const normalized = `${resolved.pathname}${resolved.search}${resolved.hash}`
  if (!isRootRelative(normalized)) return fallback
  return normalized
}

/** True only for "/" followed by something that is not another separator. */
function isRootRelative(value: string): boolean {
  return value.startsWith("/") && value[1] !== "/" && value[1] !== "\\"
}
