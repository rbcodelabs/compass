import getPrisma from "@/lib/db"
import { resolveOrgSlugRedirect } from "@/lib/org-slug"

/**
 * The organization's CURRENT slug for a retired `oldSlug`, or null when the slug
 * has no history. The history row stores the organization id (not the new slug),
 * so a chain of renames (a -> b -> c) always resolves to c.
 *
 * Misses (the overwhelmingly common case: every request whose first segment is a
 * live org slug) cost one indexed unique-key read and nothing else.
 */
export async function lookupCurrentOrgSlug(oldSlug: string): Promise<string | null> {
  const prisma = getPrisma()
  const redirect = await prisma.organizationSlugRedirect.findUnique({
    where: { oldSlug },
    select: { organizationId: true },
  })
  if (!redirect) return null
  const organization = await prisma.organization.findUnique({
    where: { id: redirect.organizationId },
    select: { slug: true },
  })
  return organization?.slug ?? null
}

/**
 * proxy.ts entry point: the path to redirect to when `pathname` addresses an
 * organization by a slug it has since renamed away from, else null.
 *
 * Fails OPEN. This runs in front of every page request, so a database hiccup
 * here must not turn into a site-wide outage; the worst outcome of swallowing
 * the error is that a renamed org's old link 404s until the next request.
 */
export async function retiredOrgSlugRedirectTarget(pathname: string, search: string): Promise<string | null> {
  try {
    return await resolveOrgSlugRedirect(pathname, search, lookupCurrentOrgSlug)
  } catch (error) {
    console.error("[proxy] org slug redirect lookup failed; continuing without redirect", error)
    return null
  }
}
