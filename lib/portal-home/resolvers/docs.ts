import type { DocsConfig } from "../widgets/docs"
import type { WidgetResolution } from "../data"
import { listPublishedDocs } from "@/lib/portal-docs/service"
import { surfaceBase, type ResolveContext } from "./context"

/**
 * PUBLISHED docs only, for every audience: the widget is a window onto the portal's docs, so the team sees
 * exactly what customers would (a member who wants an unpublished doc has the Docs section). "selected" mode
 * never publishes anything: an id that is unpublished, deleted or from another workspace just drops out.
 */
export async function resolveDocs(ctx: ResolveContext, config: DocsConfig): Promise<WidgetResolution> {
  const selected = config.mode === "selected"
  if (selected && config.docIds.length === 0) {
    return { available: false, reason: ctx.audience === "team" ? "No docs selected yet." : "No docs to show customers yet." }
  }
  const docs = await listPublishedDocs(ctx.prisma, ctx.workspace.id, {
    limit: config.maxItems,
    ...(selected ? { ids: config.docIds } : {}),
  })
  const shown = selected ? docs.slice(0, config.maxItems) : docs
  if (shown.length === 0) {
    if (ctx.audience === "team") {
      return { available: false, reason: selected ? "None of the selected docs are published." : "No docs are published yet." }
    }
    return { available: false, reason: "No published docs to show." }
  }
  const base = `${surfaceBase(ctx)}/docs`
  return {
    available: true,
    data: {
      type: "docs",
      docs: shown.map((doc) => ({ ...doc, href: `${base}/${doc.id}` })),
    },
  }
}
