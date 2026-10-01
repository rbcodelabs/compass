import type { RecentUpdatesConfig } from "../widgets/recent-updates"
import type { WidgetResolution } from "../data"
import { portalBase, publicRoadmapItemWhere, type ResolveContext } from "./context"

/** Shipped public roadmap items, newest change first. Same predicate as the public roadmap. */
export async function resolveRecentUpdates(ctx: ResolveContext, config: RecentUpdatesConfig): Promise<WidgetResolution> {
  if (!ctx.workspace.roadmapPublic) return { available: false, reason: "The public roadmap is not enabled." }

  const rows = await ctx.prisma.roadmapItem.findMany({
    where: { ...publicRoadmapItemWhere(ctx.workspace.id), horizon: { in: ["SHIPPED", "LAUNCHED"] } },
    orderBy: [{ updatedAt: "desc" }],
    take: config.limit,
    select: { id: true, title: true, updatedAt: true },
  })
  if (rows.length === 0) return { available: false, reason: "Nothing has shipped yet." }
  return {
    available: true,
    data: {
      type: "recent_updates",
      items: rows.map((row) => ({ id: row.id, title: row.title, date: row.updatedAt.toISOString() })),
      roadmapHref: `${portalBase(ctx)}/roadmap`,
    },
  }
}
