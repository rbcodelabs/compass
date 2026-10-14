/**
 * Organization URL-slug rules.
 *
 * The org slug is the first URL segment (`/{orgSlug}/{workspaceSlug}/...`), the
 * second under `/portal/`, and the third under `/api/portal/`. Renaming it does NOT
 * keep the old URLs working (see `updateOrganizationSlug`); these rules decide what
 * a new slug may be.
 *
 * No Prisma and no next/*: imported by client components and unit tests.
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
