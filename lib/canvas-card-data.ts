/**
 * Server side of Compass object cards on a canvas: live resolution and search.
 *
 * Trust model: canvas content is untrusted. A reference is only ever resolved
 * with the *workspace of the canvas doc* in the WHERE clause (never a workspace
 * named by the reference), so an id from another workspace is
 * indistinguishable from a missing one and yields the same `unavailable` view
 * with no data. Callers (server actions) must have authorized the viewer for
 * `workspaceId` before calling in.
 */
import getPrisma from "@/lib/db"
import { entityPath, workspaceBasePath } from "@/lib/entity-links"
import { listDashboardMetrics } from "@/lib/analytics/service"
import {
  CANVAS_CARD_KINDS,
  MAX_CARD_REFS,
  canvasCardKey,
  isCanvasCardRef,
  type CanvasCardKind,
  type CanvasCardRef,
} from "@/lib/canvas-cards"

export type CanvasCardFact = { label: string; value: string }
export type CanvasCardView =
  | { state: "ok"; kind: CanvasCardKind; id: string; title: string; status: string | null; facts: CanvasCardFact[]; href: string }
  | { state: "unavailable"; kind: CanvasCardKind; id: string }

export type CanvasCardSearchItem = { kind: CanvasCardKind; id: string; title: string; context?: string }

type Workspace = { workspaceId: string; orgSlug: string; workspaceSlug: string }

const pct = (n: number) => `${Math.round(n)}%`
const compact = (n: number) => (Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100))
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const fact = (label: string, value: string | number | null | undefined): CanvasCardFact[] =>
  value === null || value === undefined || value === "" ? [] : [{ label, value: String(value) }]

/**
 * Resolve references for display. Output has an entry for every valid, unique
 * input reference; anything not found in `workspaceId` is `unavailable`.
 */
export async function resolveCanvasCards(
  input: Workspace & { userId: string; refs: unknown[] }
): Promise<Record<string, CanvasCardView>> {
  const db = getPrisma()
  const { workspaceId } = input
  const unique = new Map<string, CanvasCardRef>()
  for (const ref of input.refs) {
    if (!isCanvasCardRef(ref)) continue
    const clean = { kind: ref.kind, id: ref.id.toLowerCase() }
    if (unique.size < MAX_CARD_REFS) unique.set(canvasCardKey(clean), clean)
  }
  const idsOf = (kind: CanvasCardKind) => [...unique.values()].filter((r) => r.kind === kind).map((r) => r.id)
  const slugs = { orgSlug: input.orgSlug, workspaceSlug: input.workspaceSlug }
  const out: Record<string, CanvasCardView> = {}
  const ok = (kind: CanvasCardKind, id: string, title: string, status: string | null, facts: CanvasCardFact[], href: string) => {
    out[canvasCardKey({ kind, id })] = { state: "ok", kind, id, title, status, facts, href }
  }

  const tasks: Promise<void>[] = []
  const when = (kind: CanvasCardKind, run: (ids: string[]) => Promise<void>) => {
    const ids = idsOf(kind)
    if (ids.length) tasks.push(run(ids))
  }

  when("opportunity", async (ids) => {
    const rows = await db.opportunity.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, title: true, status: true, customerSegment: true, score: { select: { normalizedScore: true } } },
    })
    for (const r of rows) ok("opportunity", r.id, r.title, r.status, [...fact("Score", r.score ? pct(r.score.normalizedScore) : null), ...fact("Segment", r.customerSegment)], entityPath({ ...slugs, type: "opportunity", id: r.id }))
  })
  when("solution", async (ids) => {
    const rows = await db.solution.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, title: true, status: true, opportunityId: true, score: { select: { normalizedScore: true } }, opportunity: { select: { title: true } } },
    })
    for (const r of rows) ok("solution", r.id, r.title, r.status, [...fact("Score", r.score ? pct(r.score.normalizedScore) : null), ...fact("Opportunity", r.opportunity?.title)], entityPath({ ...slugs, type: "solution", id: r.id, opportunityId: r.opportunityId }))
  })
  when("experiment", async (ids) => {
    const rows = await db.experiment.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true, title: true, status: true, conclusion: true, endDate: true } })
    for (const r of rows) ok("experiment", r.id, r.title, r.status, [...fact("Conclusion", r.conclusion), ...fact("Ends", day(r.endDate))], entityPath({ ...slugs, type: "experiment", id: r.id }))
  })
  when("task", async (ids) => {
    const rows = await db.task.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true, title: true, status: true, priority: true, dueDate: true } })
    for (const r of rows) ok("task", r.id, r.title, r.status, [...fact("Priority", r.priority), ...fact("Due", day(r.dueDate))], entityPath({ ...slugs, type: "task", id: r.id }))
  })
  when("doc", async (ids) => {
    const rows = await db.doc.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true, title: true, docType: true, updatedAt: true } })
    for (const r of rows) ok("doc", r.id, r.title || "Untitled", null, [...fact("Type", r.docType === "STANDARD" ? "Page" : r.docType === "CANVAS" ? "Canvas" : r.docType), ...fact("Updated", day(r.updatedAt))], entityPath({ ...slugs, type: "doc", id: r.id }))
  })
  when("objective", async (ids) => {
    const rows = await db.objective.findMany({
      where: { id: { in: ids }, workspaceId },
      select: { id: true, title: true, status: true, owner: true, keyResults: { select: { current: true, target: true } } },
    })
    for (const r of rows) {
      const ratios = r.keyResults.filter((k) => k.target > 0).map((k) => Math.min(1, k.current / k.target))
      const progress = ratios.length ? pct((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) : null
      ok("objective", r.id, r.title, r.status, [...fact("Progress", progress), ...fact("Owner", r.owner)], entityPath({ ...slugs, type: "objective", id: r.id }))
    }
  })
  when("keyResult", async (ids) => {
    const rows = await db.keyResult.findMany({
      where: { id: { in: ids }, objective: { workspaceId } },
      select: { id: true, title: true, current: true, target: true, unit: true },
    })
    for (const r of rows) {
      const unit = r.unit ? ` ${r.unit}` : ""
      ok("keyResult", r.id, r.title, null, [{ label: "Progress", value: `${compact(r.current)} / ${compact(r.target)}${unit}` }], entityPath({ ...slugs, type: "keyResult", id: r.id }))
    }
  })
  when("assumption", async (ids) => {
    // Assumptions carry no workspace column of their own; scope through the owning solution.
    const rows = await db.assumption.findMany({
      where: { id: { in: ids }, solution: { workspaceId } },
      select: { id: true, title: true, status: true, riskLevel: true, solution: { select: { opportunityId: true, title: true } } },
    })
    for (const r of rows) ok("assumption", r.id, r.title, r.status, [...fact("Risk", r.riskLevel), ...fact("Solution", r.solution?.title)], entityPath({ ...slugs, type: "assumption", id: r.id, opportunityId: r.solution?.opportunityId }))
  })
  when("roadmapItem", async (ids) => {
    const rows = await db.roadmapItem.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true, title: true, status: true, horizon: true } })
    for (const r of rows) ok("roadmapItem", r.id, r.title, r.status, [...fact("Horizon", r.horizon)], entityPath({ ...slugs, type: "roadmapItem", id: r.id }))
  })
  when("metric", async (ids) => {
    // The analytics service authorizes the viewer itself (membership, operator-only
    // providers); any refusal means every metric card is simply unavailable.
    let metrics: Awaited<ReturnType<typeof listDashboardMetrics>>
    try {
      metrics = await listDashboardMetrics({ userId: input.userId, purpose: "USER", scopeWorkspaceId: workspaceId }, workspaceId)
    } catch {
      return
    }
    const wanted = new Set(ids)
    for (const m of metrics) {
      if (!wanted.has(m.metric.id)) continue
      const unit = m.metric.unit ? ` ${m.metric.unit}` : ""
      const delta = m.delta ? `${m.delta.direction === "up" ? "Up" : "Down"} ${compact(Math.abs(m.delta.diff))}` : null
      ok("metric", m.metric.id, m.metric.name, m.status, [...fact("Latest", m.value === null ? null : `${compact(m.value)}${unit}`), ...fact("Trend", delta), ...fact("Freshness", m.statusCaption)], `${workspaceBasePath(slugs)}/metrics`)
    }
  })

  await Promise.all(tasks)
  for (const [key, ref] of unique) if (!out[key]) out[key] = { state: "unavailable", kind: ref.kind, id: ref.id }
  return out
}

/** Title search across the card kinds, scoped to one workspace. */
export async function searchCanvasCardTargets(input: { workspaceId: string; query: string }): Promise<CanvasCardSearchItem[]> {
  const db = getPrisma()
  const q = input.query.trim()
  if (q.length < 1 || q.length > 100) return []
  const { workspaceId } = input
  const title = { contains: q, mode: "insensitive" as const }
  const take = 6
  const orderBy = [{ title: "asc" as const }, { id: "asc" as const }]
  const [opps, sols, exps, tasks, docs, objs, krs, metrics, assumptions, roadmapItems] = await Promise.all([
    db.opportunity.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, status: true } }),
    db.solution.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, status: true } }),
    db.experiment.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, status: true } }),
    db.task.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, status: true } }),
    db.doc.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, docType: true } }),
    db.objective.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, status: true } }),
    db.keyResult.findMany({ where: { objective: { workspaceId }, title }, take, orderBy, select: { id: true, title: true } }),
    db.metricRevision.findMany({
      where: { workspaceId, name: title },
      take: 40,
      orderBy: [{ name: "asc" }],
      select: { name: true, metricId: true, id: true },
    }),
    db.assumption.findMany({ where: { solution: { workspaceId }, title }, take, orderBy, select: { id: true, title: true, status: true } }),
    db.roadmapItem.findMany({ where: { workspaceId, title }, take, orderBy, select: { id: true, title: true, horizon: true } }),
  ])
  // Metric names live on revisions; only a definition's *current* revision counts.
  const currentRevisions = metrics.length
    ? await db.metricDefinition.findMany({ where: { workspaceId, archived: false, currentRevisionId: { in: metrics.map((m) => m.id) } }, select: { id: true, currentRevisionId: true } })
    : []
  const currentIds = new Set(currentRevisions.map((d) => d.currentRevisionId))
  const items: CanvasCardSearchItem[] = [
    ...opps.map((r) => ({ kind: "opportunity" as const, id: r.id, title: r.title, context: r.status })),
    ...sols.map((r) => ({ kind: "solution" as const, id: r.id, title: r.title, context: r.status })),
    ...metrics.filter((m) => currentIds.has(m.id)).slice(0, take).map((r) => ({ kind: "metric" as const, id: r.metricId, title: r.name })),
    ...docs.map((r) => ({ kind: "doc" as const, id: r.id, title: r.title || "Untitled", context: r.docType === "STANDARD" ? undefined : r.docType })),
    ...tasks.map((r) => ({ kind: "task" as const, id: r.id, title: r.title, context: r.status })),
    ...exps.map((r) => ({ kind: "experiment" as const, id: r.id, title: r.title, context: r.status })),
    ...objs.map((r) => ({ kind: "objective" as const, id: r.id, title: r.title, context: r.status })),
    ...krs.map((r) => ({ kind: "keyResult" as const, id: r.id, title: r.title })),
    ...assumptions.map((r) => ({ kind: "assumption" as const, id: r.id, title: r.title, context: r.status })),
    ...roadmapItems.map((r) => ({ kind: "roadmapItem" as const, id: r.id, title: r.title, context: r.horizon })),
  ]
  const order = new Map(CANVAS_CARD_KINDS.map((k, i) => [k, i]))
  return items.sort((a, b) => (order.get(a.kind)! - order.get(b.kind)!))
}
