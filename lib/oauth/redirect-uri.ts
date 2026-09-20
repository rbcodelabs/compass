/**
 * `redirect_uri` matching.
 *
 * Two rules, and the split between them is the whole point of this module:
 *
 *  1. **Exact string comparison** against a registered value, per OAuth 2.1
 *     §4.1.2.1. No wildcards, no prefix matching, no "same host is close
 *     enough". `https://claude.ai/api/mcp/auth_callback` matches only itself.
 *  2. **A port-agnostic exception for loopback**, per RFC 8252 §7.3: *"the
 *     authorization server MUST allow any port to be specified at the time of
 *     the request"*. This is not a nicety. The Geode broker registers a
 *     **portless** `http://127.0.0.1/callback` at DCR time and then authorizes
 *     with whatever ephemeral port its local callback server bound — a
 *     different port on every single authorization. An AS that enforces exact
 *     port matching rejects the callback of the *second* authorization from a
 *     given install, and nowhere else. Claude Code has the same shape, and
 *     declares both `http://localhost/callback` and `http://127.0.0.1/callback`.
 *
 * The exception is scoped to the two loopback hostnames the design names, and
 * to the port alone: scheme, host, path, query and fragment must still all be
 * equal. Widening it in any other direction turns a registered callback into an
 * open redirect for authorization codes.
 */

/**
 * The only hosts the port-agnostic exception applies to.
 *
 * `[::1]` is deliberately **not** here. RFC 8252 names it, but the Compass
 * design scopes the carve-out to these two, and no client Compass targets
 * registers an IPv6 loopback callback. Adding it later is additive; every
 * client that needs it today also registers `127.0.0.1`.
 */
export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost"] as const

function parse(uri: string): URL | null {
  if (typeof uri !== "string" || uri.length === 0) return null
  try {
    return new URL(uri)
  } catch {
    return null
  }
}

/**
 * True when `uri` is a syntactically valid URI whose **host component** is a
 * loopback host.
 *
 * Reading the host off a parsed `URL` rather than string-matching is what makes
 * `http://127.0.0.1.evil.com/cb` (host `127.0.0.1.evil.com`) and
 * `http://127.0.0.1@evil.com/cb` (host `evil.com`, userinfo `127.0.0.1`) both
 * come out false.
 *
 * It also means the alternate IPv4 spellings the WHATWG parser canonicalises —
 * `2130706433`, `0x7f000001`, `127.1` — come out true. That is correct: each
 * one addresses the caller's own loopback interface, so there is nowhere for an
 * authorization code to leak to. `[::1]` is *not* canonicalised to either of
 * these hostnames and so stays outside the carve-out.
 */
export function isLoopbackRedirectUri(uri: string): boolean {
  const url = parse(uri)
  if (!url) return false
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname)
}

/**
 * Does `requested` satisfy the single registered value `registered`?
 *
 * Non-loopback pairs are compared as raw strings, so a registered
 * `https://claude.ai/cb` does not match `https://claude.ai:443/cb` even though
 * the two normalise to the same URL — simple string comparison is what OAuth
 * 2.1 mandates, and the normalising variant is exactly how "close enough"
 * matching bugs start.
 */
export function redirectUriMatches(registered: string, requested: string): boolean {
  if (typeof registered !== "string" || typeof requested !== "string") return false
  if (registered.length === 0 || requested.length === 0) return false

  // Rule 1. Cheap, and covers every non-loopback client.
  if (registered === requested) return parse(registered) !== null

  // Rule 2. Both sides must be loopback before the port is allowed to differ.
  const left = parse(registered)
  const right = parse(requested)
  if (!left || !right) return false
  if (!isLoopbackUrl(left) || !isLoopbackUrl(right)) return false

  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search &&
    left.hash === right.hash
  )
}

/**
 * Finds the registered redirect URI that `requested` satisfies, or `null`.
 *
 * Returns the *registered* string rather than a boolean so callers can log and
 * echo the value that was actually matched instead of the attacker-supplied
 * one.
 */
export function matchRedirectUri(
  registeredUris: readonly string[],
  requested: string,
): string | null {
  if (!Array.isArray(registeredUris)) return null
  return registeredUris.find((registered) => redirectUriMatches(registered, requested)) ?? null
}

function isLoopbackUrl(url: URL): boolean {
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(url.hostname)
}
