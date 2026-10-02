import type { RecentUpdatesConfig } from "../widgets/recent-updates"
import type { WidgetResolution } from "../data"
import { internalRoadmapItemWhere, publicRoadmapItemWhere, surfaceBase, type ResolveContext } from "./context"

/** Shipped roadmap items, newest change first. Customers: the public roadmap predicate. Team: every non-archived item, private included. */
export async function resolveRecentUpdates(ctx: ResolveContext, config: RecentUpdatesConfig): Promise<WidgetResolution> {
  if (ctx.audience === "customer" && !ctx.workspace.roadmapPublic) return { available: false, reason: "The public roadmap is not enabled." }

  const base = ctx.audience === "team" ? internalRoadmapItemWhere(ctx) : publicRoadmapItemWhere(ctx.workspace.id)
  const rows = await ctx.prisma.roadmapItem.findMany({
    where: { ...base, horizon: { in: ["SHIPPED", "LAUNCHED"] } },
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
      roadmapHref: `${surfaceBase(ctx)}/roadmap`,
    },
  }
}
