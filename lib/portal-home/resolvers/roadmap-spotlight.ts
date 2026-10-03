import type { RoadmapSpotlightConfig } from "../widgets/roadmap-spotlight"
import type { WidgetResolution, SpotlightItem } from "../data"
import { HORIZON_META, portalBucketFor } from "@/lib/roadmap"
import type { Horizon } from "@/lib/types"
import { internalRoadmapItemWhere, publicRoadmapItemWhere, surfaceBase, type ResolveContext } from "./context"

const AUTO_LIMIT = 4

export async function resolveRoadmapSpotlight(ctx: ResolveContext, config: RoadmapSpotlightConfig): Promise<WidgetResolution> {
  if (ctx.audience === "customer" && !ctx.workspace.roadmapPublic) return { available: false, reason: "The public roadmap is not enabled." }

  const base = ctx.audience === "team" ? internalRoadmapItemWhere(ctx) : publicRoadmapItemWhere(ctx.workspace.id)
  const pinned = config.itemIds.length > 0
  const rows = await ctx.prisma.roadmapItem.findMany({
    where: pinned
      ? { ...base, id: { in: config.itemIds } }
      : { ...base, horizon: "NOW" },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    take: pinned ? config.itemIds.length : AUTO_LIMIT,
    select: { id: true, title: true, horizon: true, startDate: true, endDate: true },
  })

  // Pinned items keep the admin's order; ids that are archived (and, for customers, private), deleted
  // or from another workspace were already excluded by the query and simply drop out.
  const byId = new Map(rows.map((row) => [row.id, row]))
  const ordered = pinned ? config.itemIds.map((id) => byId.get(id)).filter((row): row is NonNullable<typeof row> => !!row) : rows

  const items: SpotlightItem[] = []
  for (const row of ordered) {
    const bucket = portalBucketFor(row.horizon)
    if (!bucket) continue
    items.push({
      id: row.id,
      title: row.title,
      statusHorizon: bucket,
      statusLabel: HORIZON_META[bucket as Horizon].label,
      window: row.startDate && row.endDate ? { start: row.startDate.toISOString(), end: row.endDate.toISOString() } : null,
    })
  }
  if (items.length === 0) {
    if (ctx.audience === "team") return { available: false, reason: pinned ? "None of the pinned items are available." : "No items are in progress." }
    return { available: false, reason: pinned ? "None of the pinned items are public." : "No public items are in progress." }
  }
  return { available: true, data: { type: "roadmap_spotlight", items, auto: !pinned, roadmapHref: `${surfaceBase(ctx)}/roadmap` } }
}
