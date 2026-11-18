import type { OkrSummaryConfig } from "../widgets/okr-summary"
import type { WidgetResolution } from "../data"
import { surfaceBase, type ResolveContext } from "./context"

/**
 * Team audience only (OKRs are internal): a customer resolution is unavailable before any query runs.
 * "active" = the active cycle containing today (else any active cycle); "cycle" = the chosen cycle;
 * "selected" = the chosen objectives in the admin's order, from any cycle of this workspace.
 */
export async function resolveOkrSummary(ctx: ResolveContext, config: OkrSummaryConfig): Promise<WidgetResolution> {
  if (ctx.audience !== "team") return { available: false, reason: "OKRs are internal and are not shown to customers." }
  const workspaceId = ctx.workspace.id
  const select = { id: true, title: true } as const
  const objectiveSelect = {
    id: true,
    title: true,
    status: true,
    cycle: { select: { title: true } },
    keyResults: { select: { target: true, current: true } },
  } as const

  let cycleTitle: string | null = null
  let objectives
  if (config.mode === "selected") {
    if (config.objectiveIds.length === 0) return { available: false, reason: "No objectives selected yet." }
    const found = await ctx.prisma.objective.findMany({ where: { workspaceId, id: { in: config.objectiveIds } }, select: objectiveSelect })
    objectives = config.objectiveIds.flatMap((id) => found.filter((o) => o.id === id)).slice(0, config.maxObjectives)
  } else {
    let cycle: { id: string; title: string } | null
    if (config.mode === "cycle") {
      if (!config.cycleId) return { available: false, reason: "No OKR cycle selected yet." }
      cycle = await ctx.prisma.oKRCycle.findFirst({ where: { workspaceId, id: config.cycleId }, select })
      if (!cycle) return { available: false, reason: "The selected OKR cycle no longer exists." }
    } else {
      const now = new Date()
      cycle =
        (await ctx.prisma.oKRCycle.findFirst({ where: { workspaceId, status: "ACTIVE", startDate: { lte: now }, endDate: { gte: now } }, orderBy: [{ startDate: "desc" }], select })) ??
        (await ctx.prisma.oKRCycle.findFirst({ where: { workspaceId, status: "ACTIVE" }, orderBy: [{ startDate: "desc" }], select }))
    }
    cycleTitle = cycle ? cycle.title : null
    objectives = await ctx.prisma.objective.findMany({
      where: { workspaceId, cycleId: cycle ? cycle.id : null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      take: config.maxObjectives,
      select: objectiveSelect,
    })
  }
  if (objectives.length === 0) return { available: false, reason: "No objectives to show." }
  return {
    available: true,
    data: {
      type: "okr_summary",
      cycleTitle,
      okrsHref: `${surfaceBase(ctx)}/okrs`,
      objectives: objectives.map((objective) => {
        const ratios = objective.keyResults.map((kr) => (kr.target > 0 ? Math.min(1, Math.max(0, kr.current / kr.target)) : 0))
        const progress = ratios.length ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) : 0
        return {
          id: objective.id,
          title: objective.title,
          status: objective.status,
          progress,
          keyResultCount: ratios.length,
          cycleTitle: objective.cycle ? objective.cycle.title : null,
        }
      }),
    },
  }
}
