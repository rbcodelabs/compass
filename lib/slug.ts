/**
 * URL-slug derivation.
 *
 * The same three-step transform (lowercase → collapse non-alphanumerics to a
 * single hyphen → trim leading/trailing hyphens) was written out inline in two
 * places: `app/onboarding/onboarding-form.tsx` derives the *org* slug live as
 * the user types, and `app/onboarding/actions.ts` derives the first
 * *workspace's* slug server-side. The org-settings "Create workspace" form
 * would have been the third copy.
 *
 * The two existing copies differ only in their empty-result behaviour — the
 * form leaves the field blank (so the user sees nothing rather than a
 * placeholder they did not type), the action substitutes "workspace" (so a
 * name of e.g. "日本語" still produces a routable slug). That difference is the
 * `fallback` parameter rather than two functions.
 *
 * The output always satisfies /^[a-z0-9-]+$/ — the pattern enforced by the MCP
 * `create_workspace` input schema and by `OnboardingSchema` — except when it is
 * the empty string, which callers must treat as "no slug yet".
 *
 * No Prisma, no next/*: this module is imported by client components.
 */
export function deriveSlug(value: string, fallback = ""): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || fallback
  )
}

/** The slug shape accepted by org/workspace routes and the MCP input schema. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/
