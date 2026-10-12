/**
 * Organization URL-slug rules and retired-slug redirect resolution.
 *
 * The org slug is the first URL segment (`/{orgSlug}/{workspaceSlug}/...`), the
 * second under `/portal/`, and the third under `/api/portal/`. Renaming it would
 * break every bookmark, email link and — most importantly — every customer's
 * hard-coded portal / SSO URL, so a rename writes an `OrganizationSlugRedirect`
 * row (migration 080) and `proxy.ts` redirects the old path to the new one using
 * `resolveOrgSlugRedirect` below.
 *
 * No Prisma and no next/*: the pure parts are imported by client components and
 * unit tests; the DB lookups are injected by the caller.
 */
import { SLUG_PATTERN } from "@/lib/slug"

export const ORG_SLUG_MIN_LENGTH = 2
/** One DNS label. Org slugs are not hostnames today, but this keeps subdomains possible. */
export const ORG_SLUG_MAX_LENGTH = 63

/**
 * Org slugs that would be shadowed by, or shadow, a static top-level route.
 * `/{orgSlug}` is a dynamic segment, so Next resolves a static sibling directory
 * ahead of it: an org called `login` would be unreachable, and worse, would make
 * `/login` ambiguous. Add a word here whenever a new top-level directory is added
 * under `app/` (the unit test fails if one is missing), plus the non-directory
 * prefixes the proxy and `public/` serve.
 */
export const RESERVED_ORG_SLUGS: ReadonlySet<string> = new Set([
  // Static route directories under app/ (guarded by __tests__/org-slug.test.ts).
  "api",
  "dashboard",
  "embed",
  "help",
  "login",
  "oauth",
  "onboarding",
  "portal",
  "preview-login",
  "research",
  "settings",
  "ui",
  // Served by the proxy / public/ or routed specially; not app/ directories.
  "auth",
  "vendor",
  "screenshots",
  "favicon",
  "well-known",
  // Words that read as product surfaces or would invite phishing-style URLs.
  "admin",
  "static",
  "www",
])

export function isReservedOrgSlug(slug: string): boolean {
  return RESERVED_ORG_SLUGS.has(slug)
}

/**
 * Returns a user-facing error for an unacceptable org slug, or null when it is
 * acceptable. Does not check uniqueness (that needs the database).
 */
export function validateOrgSlug(slug: string): string | null {
  if (!slug) return "URL slug is required."
  if (!SLUG_PATTERN.test(slug)) {
    return "URL slug may only contain lowercase letters, numbers, and hyphens."
  }
  if (slug.startsWith("-") || slug.endsWith("-")) {
    return "URL slug cannot start or end with a hyphen."
  }
  if (slug.length < ORG_SLUG_MIN_LENGTH) {
    return `URL slug must be at least ${ORG_SLUG_MIN_LENGTH} characters.`
  }
  if (slug.length > ORG_SLUG_MAX_LENGTH) {
    return `URL slug must be ${ORG_SLUG_MAX_LENGTH} characters or fewer.`
  }
  if (isReservedOrgSlug(slug)) {
    return `"${slug}" is a reserved word and cannot be used as a URL slug.`
  }
  return null
}

/**
 * Index (into the `/`-split path, ignoring the leading empty entry) of the
 * segment that holds an org slug, or null when the path has none.
 *
 *   /{org}/...             -> 0
 *   /portal/{org}/...      -> 1
 *   /api/portal/{org}/...  -> 2
 *
 * `/api/v1/...` and `/api/mcp` are deliberately excluded: programmatic callers
 * pass the slug as an explicit argument and must see a clear "not found" rather
 * than a silent redirect (see docs/content/09-mcp-api.md).
 */
export function orgSlugSegmentIndex(pathname: string): number | null {
  const segments = pathname.split("/").slice(1)
  let index: number
  if (segments[0] === "portal") index = 1
  else if (segments[0] === "api" && segments[1] === "portal") index = 2
  else index = 0

  const candidate = segments[index]
  if (!candidate) return null
  // Static routes, `_next`, `.well-known`, files with an extension, uppercase
  // or otherwise non-slug segments can never be an org slug.
  if (!SLUG_PATTERN.test(candidate) || isReservedOrgSlug(candidate)) return null
  return index
}

/**
 * If `pathname` addresses an organization by a slug it has since retired,
 * returns the same path (plus `search`) under the organization's current slug;
 * otherwise null.
 *
 * `lookupCurrentSlug(oldSlug)` returns the owning organization's CURRENT slug, or
 * null when `oldSlug` has no history.
 */
export async function resolveOrgSlugRedirect(
  pathname: string,
  search: string,
  lookupCurrentSlug: (oldSlug: string) => Promise<string | null>,
): Promise<string | null> {
  const index = orgSlugSegmentIndex(pathname)
  if (index === null) return null

  const parts = pathname.split("/")
  // parts[0] is the empty string before the leading slash.
  const oldSlug = parts[index + 1]
  const currentSlug = await lookupCurrentSlug(oldSlug)
  // A live organization that also has a stale history row must win, not redirect to itself.
  if (!currentSlug || currentSlug === oldSlug) return null

  parts[index + 1] = currentSlug
  return `${parts.join("/")}${search}`
}
