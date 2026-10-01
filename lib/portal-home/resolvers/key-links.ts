import type { KeyLinksConfig } from "../widgets/key-links"
import type { PortalHomeLink, WidgetResolution } from "../data"
import type { ResolveContext } from "./context"

/**
 * External URL links are always returned (the admin typed them for customers).
 * Doc links are different: Docs have no public visibility in v1, so a Doc's
 * title (itself non-public data) and route are returned to workspace members
 * only, and only for a Doc that really belongs to this workspace. Customers
 * never receive them, even if an admin pinned one.
 */
export async function resolveKeyLinks(ctx: ResolveContext, config: KeyLinksConfig): Promise<WidgetResolution> {
  const docIds = config.links.flatMap((link) => (link.kind === "doc" ? [link.docId] : []))
  const docs =
    ctx.isWorkspaceMember && docIds.length > 0
      ? await ctx.prisma.doc.findMany({
          where: { workspaceId: ctx.workspace.id, id: { in: docIds } },
          select: { id: true, title: true },
        })
      : []
  const docTitles = new Map(docs.map((doc) => [doc.id, doc.title]))

  const links: PortalHomeLink[] = []
  for (const link of config.links) {
    if (link.kind === "url") {
      links.push({ kind: "url", label: link.label, href: link.url, external: !link.url.startsWith("/") })
    } else if (ctx.isWorkspaceMember) {
      const title = docTitles.get(link.docId)
      if (!title) continue
      links.push({
        kind: "doc",
        label: link.label || title,
        href: `/${ctx.workspace.orgSlug}/${ctx.workspace.workspaceSlug}/docs/${link.docId}`,
        external: false,
      })
    }
  }
  if (links.length === 0) return { available: false, reason: "No links to show customers yet." }
  return { available: true, data: { type: "key_links", links } }
}
