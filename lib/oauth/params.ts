/**
 * Reading OAuth request parameters, from a query string or a form body.
 *
 * Its own module, separate from `lib/oauth/http.ts`, so the authorize path can
 * use it without importing `next/server` — `lib/oauth/authorize-request.ts` is
 * reached from a React Server Component and has no business pulling in the
 * response machinery to read a query string.
 */

/** A single occurrence of `name`, trimmed, or `null` if absent/empty/repeated. */
export function singleParam(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name)
  if (all.length !== 1) return null
  const value = all[0].trim()
  return value.length > 0 ? value : null
}

/**
 * The first parameter in `names` that appears more than once, or `null`.
 *
 * RFC 6749 §3.1 forbids repeating a request parameter, and a repeat has to be a
 * hard rejection rather than something a reader resolves by picking a copy.
 * Two reasons, and the second is the one that actually bites:
 *
 *  1. Two components that pick *different* copies disagree about the request —
 *     the classic parameter-pollution shape, where a consent screen displays one
 *     `redirect_uri` and the code is delivered to another.
 *  2. Treating a repeat as *absent* is worse still, because "absent" is often a
 *     meaningful state with a lenient default. A duplicated `redirect_uri` would
 *     otherwise fall through to "the client omitted it, so use the single
 *     registered one" — silently rewriting an ambiguous request into a valid one.
 */
export function firstDuplicateParameter(
  params: URLSearchParams,
  names: readonly string[],
): string | null {
  return names.find((name) => params.getAll(name).length > 1) ?? null
}
