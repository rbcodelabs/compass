import type { KeyLinksConfig } from "../widgets/key-links"
import type { PortalHomeLink, WidgetResolution } from "../data"
import { listPublishedDocs } from "@/lib/portal-docs/service"
import { surfaceBase, type ResolveContext } from "./context"

/**
 * External URL links are always returned (the admin typed them for customers).
 * Doc links depend on the audience. Workspace members get any Doc that really
 * belongs to this workspace (they can open it in Compass). Customers get a Doc
 * link ONLY when that Doc is published to the portal (published, same
 * workspace, not deleted); its title is then public data and the link points
 * at the portal doc page. An unpublished Doc is dropped for customers even if
 * an admin pinned it.
 */
export async function resolveKeyLinks(ctx: ResolveContext, config: KeyLinksConfig): Promise<WidgetResolution> {
  const docIds = config.links.flatMap((link) => (link.kind === "doc" ? [link.docId] : []))
  let docTitles = new Map<string, string>()
  if (docIds.length > 0) {
    if (ctx.audience === "team") {
      const docs = await ctx.prisma.doc.findMany({
        where: { workspaceId: ctx.workspace.id, id: { in: docIds } },
        select: { id: true, title: true },
      })
      docTitles = new Map(docs.map((doc) => [doc.id, doc.title]))
    } else {
      const docs = await listPublishedDocs(ctx.prisma, ctx.workspace.id, { ids: docIds })
      docTitles = new Map(docs.map((doc) => [doc.id, doc.title]))
    }
  }

  const links: PortalHomeLink[] = []
  for (const link of config.links) {
    if (link.kind === "url") {
      links.push({ kind: "url", label: link.label, href: link.url, external: !link.url.startsWith("/") })
    } else {
      const title = docTitles.get(link.docId)
      if (!title) continue
      links.push({
        kind: "doc",
        docId: link.docId,
        label: link.label || title,
        href: `${surfaceBase(ctx)}/docs/${link.docId}`,
        external: false,
      })
    }
  }
  if (links.length === 0) return { available: false, reason: ctx.audience === "team" ? "No links yet." : "No links to show customers yet." }
  return { available: true, data: { type: "key_links", links } }
}
