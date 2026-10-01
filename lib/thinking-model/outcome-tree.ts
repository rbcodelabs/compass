/**
 * The workspace outcome tree (ADR "Thinking-model presets", Phase 3C).
 *
 * PURE and client-safe: flat arrays in, a plain serializable tree out, in the same
 * flat-query-plus-in-memory-join style as lib/canvas/data.ts. No Prisma, no server
 * imports. The loader (outcome-tree-data.ts) hands in workspace-filtered rows, so
 * every row here is already known to belong to one workspace; a link whose
 * endpoint is not among the rows (hidden, drifted or NULL-workspace) is ignored.
 *
 * Two derivations, selected by the preset's `tree` shape. CLASSIC ("kr-rooted")
 * uses neither and never reaches this module.
 *
 *  outcome-rooted (TORRES_OST). Each Objective is a root. Its Key Results are a
 *    compact "success metric" strip, not tree nodes. Children are the linked
 *    Opportunities (the typed Opportunity-to-Objective edges), each with its home Solutions.
 *    A Solution carries one chip per Key Result it targets (the typed Solution-to-Key-Result edges);
 *    a chip is marked cross-outcome when that Key Result sits under an Objective the
 *    Opportunity is not linked to (shown, never hidden).
 *
 *  objective-rooted-pool (OPPORTUNITY_FIRST_OKR). Pool -> Objective -> Key Result ->
 *    Solution: the same roots, but each Key Result lists the Solutions that target it,
 *    and the root lists its linked Opportunities' Solutions that target none of its
 *    Key Results as `looseSolutionIds`.
 *
 * Shared rules:
 *  - An Opportunity linked to several Objectives is rendered once, as a "home"
 *    placement under the first Objective by sort order, and as an "also" stub under
 *    the others. The subtree body exists once in `opportunities`, so stubs can expand
 *    without duplicating data, and rollups count each entity once (home placements only).
 *  - Unlinked, non-archived Opportunities go in `pool`. ARCHIVED ones, and their
 *    Solutions, are excluded everywhere.
 *  - Legacy fallback: an Opportunity with NO link row falls back to its legacy
 *    pointer (linkedKeyResultId -> that Key Result's Objective), so one whose backfill
 *    was quarantined does not land in the pool. Link rows always win.
 *  - Cycles are never required: a cycle chip appears only where the Objective has one.
 *  - A child Objective (parentKeyResultId) gets a "supports" chip; it is not nested.
 *  - Output order is fully determined by (sortOrder, createdAt, id), never input order. NOTE: Objective.sortOrder is
 *    per cycle, so across cycles the "first Objective" that holds a multi-parent Opportunity's subtree is in practice
 *    decided by createdAt: deterministic and stable, but not a meaningful ranking. It is a display choice only; every
 *    other Objective still lists the Opportunity as an "also under" stub.
 */
import type { TreeShape } from "./presets"

type Sortable = { id: string; sortOrder: number; createdAt?: number }

export type TreeObjectiveInput = Sortable & {
  title: string
  status?: string | null
  cycle?: { id: string; title: string } | null
  parentKeyResultId?: string | null
}
export type TreeKeyResultInput = Sortable & {
  objectiveId: string
  title: string
  current: number
  target: number
  unit?: string | null
}
export type TreeOpportunityInput = Sortable & { title: string; status: string }
export type TreeSolutionInput = Sortable & { opportunityId: string; title: string; status: string }
export type ObjectiveOpportunityLinkInput = { objectiveId: string; opportunityId: string }
export type SolutionKeyResultEdgeInput = { solutionId: string; keyResultId: string }
export type LegacyPointerInput = { opportunityId: string; keyResultId: string }

export type OutcomeTreeShape = Exclude<TreeShape, "kr-rooted">

export type BuildOutcomeTreeInput = {
  objectives: readonly TreeObjectiveInput[]
  keyResults: readonly TreeKeyResultInput[]
  opportunities: readonly TreeOpportunityInput[]
  solutions: readonly TreeSolutionInput[]
  objectiveOpportunityLinks: readonly ObjectiveOpportunityLinkInput[]
  solutionKeyResultEdges: readonly SolutionKeyResultEdgeInput[]
  legacyPointers: readonly LegacyPointerInput[]
  /** Defaults to "outcome-rooted". */
  shape?: OutcomeTreeShape
}

export type KeyResultStripItem = {
  id: string
  title: string
  current: number
  target: number
  unit: string | null
  /** 0..1, clamped; null when the target is not positive. */
  progress: number | null
  /** objective-rooted-pool only: Solutions targeting this Key Result. Empty otherwise. */
  solutionIds: string[]
}

export type SupportingOf = {
  keyResultId: string
  keyResultTitle: string
  objectiveId: string
  objectiveTitle: string
}

export type OutcomeRootChild = {
  opportunityId: string
  /** "home": the subtree renders here. "also": a stub pointing at the home Objective. */
  placement: "home" | "also"
  /** Set on "also" stubs: the Objective that holds the subtree. */
  homeObjective: { id: string; title: string } | null
}

export type OutcomeRoot = {
  id: string
  title: string
  status: string | null
  cycle: { id: string; title: string } | null
  supports: SupportingOf | null
  keyResults: KeyResultStripItem[]
  children: OutcomeRootChild[]
  /** objective-rooted-pool only. Empty for outcome-rooted. */
  looseSolutionIds: string[]
  /** Distinct linked Opportunities, home and stubs together. */
  linkedOpportunityCount: number
  /** Home placements only, so summing roots plus the pool counts each entity once. */
  rollup: { opportunities: number; solutions: number }
}

export type KrChip = {
  keyResultId: string
  title: string
  objectiveId: string
  objectiveTitle: string
  crossOutcome: boolean
}

export type SolutionNode = {
  id: string
  opportunityId: string
  title: string
  status: string
  krChips: KrChip[]
}

export type OpportunityNode = {
  id: string
  title: string
  status: string
  /** True when its Objective placement came from the legacy pointer, not a link row. */
  viaLegacyPointer: boolean
  /** Objectives it sits under, in root order. The first is the home. Empty for the pool. */
  objectiveIds: string[]
  solutionIds: string[]
}

export type OutcomeTree = {
  shape: OutcomeTreeShape
  roots: OutcomeRoot[]
  pool: string[]
  opportunities: Record<string, OpportunityNode>
  solutions: Record<string, SolutionNode>
  totals: { objectives: number; opportunities: number; solutions: number; pool: number }
}

const compareSortable = (a: Sortable, b: Sortable): number =>
  a.sortOrder - b.sortOrder || (a.createdAt ?? 0) - (b.createdAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

const sorted = <T extends Sortable>(rows: readonly T[]): T[] => [...rows].sort(compareSortable)

const progressOf = (current: number, target: number): number | null =>
  target > 0 ? Math.max(0, Math.min(1, current / target)) : null

export function buildOutcomeTree(input: BuildOutcomeTreeInput): OutcomeTree {
  const shape: OutcomeTreeShape = input.shape ?? "outcome-rooted"

  const objectives = sorted(input.objectives)
  const objectiveById = new Map(objectives.map((o) => [o.id, o]))
  const objectiveRank = new Map(objectives.map((o, index) => [o.id, index]))

  // Key Results only count under an Objective that is in the data.
  const keyResults = sorted(input.keyResults).filter((kr) => objectiveById.has(kr.objectiveId))
  const keyResultById = new Map(keyResults.map((kr) => [kr.id, kr]))

  // Archived opportunities (and their solutions) are gone from the tree entirely.
  const opportunities = sorted(input.opportunities).filter((o) => o.status !== "ARCHIVED")
  const opportunityById = new Map(opportunities.map((o) => [o.id, o]))
  const solutions = sorted(input.solutions).filter((s) => opportunityById.has(s.opportunityId))
  const solutionById = new Map(solutions.map((s) => [s.id, s]))

  // Opportunity -> Objectives by link row (deduped, endpoints must be in the data).
  const linkedObjectives = new Map<string, Set<string>>()
  for (const link of input.objectiveOpportunityLinks) {
    if (!objectiveById.has(link.objectiveId) || !opportunityById.has(link.opportunityId)) continue
    const set = linkedObjectives.get(link.opportunityId) ?? new Set<string>()
    set.add(link.objectiveId)
    linkedObjectives.set(link.opportunityId, set)
  }

  // Legacy fallback, only for opportunities with no usable link row.
  const legacyObjective = new Map<string, string>()
  for (const pointer of input.legacyPointers) {
    if (linkedObjectives.has(pointer.opportunityId) || !opportunityById.has(pointer.opportunityId)) continue
    const kr = keyResultById.get(pointer.keyResultId)
    if (kr) legacyObjective.set(pointer.opportunityId, kr.objectiveId)
  }

  const solutionsByOpportunity = new Map<string, TreeSolutionInput[]>()
  for (const solution of solutions) {
    const list = solutionsByOpportunity.get(solution.opportunityId) ?? []
    list.push(solution)
    solutionsByOpportunity.set(solution.opportunityId, list)
  }

  const opportunityNodes: Record<string, OpportunityNode> = {}
  const pool: string[] = []
  const objectiveIdsOf = new Map<string, string[]>()
  for (const opportunity of opportunities) {
    const direct = linkedObjectives.get(opportunity.id)
    const legacy = legacyObjective.get(opportunity.id)
    const ids = direct ? [...direct] : legacy ? [legacy] : []
    ids.sort((a, b) => (objectiveRank.get(a) ?? 0) - (objectiveRank.get(b) ?? 0))
    objectiveIdsOf.set(opportunity.id, ids)
    if (ids.length === 0) pool.push(opportunity.id)
    opportunityNodes[opportunity.id] = {
      id: opportunity.id,
      title: opportunity.title,
      status: opportunity.status,
      viaLegacyPointer: !direct && legacy !== undefined,
      objectiveIds: ids,
      solutionIds: (solutionsByOpportunity.get(opportunity.id) ?? []).map((s) => s.id),
    }
  }

  // Solution -> Key Results (deduped, endpoints must be in the data), in Key Result order.
  const keyResultRank = new Map(keyResults.map((kr, index) => [kr.id, index]))
  const targetedKeyResults = new Map<string, Set<string>>()
  for (const link of input.solutionKeyResultEdges) {
    if (!solutionById.has(link.solutionId) || !keyResultById.has(link.keyResultId)) continue
    const set = targetedKeyResults.get(link.solutionId) ?? new Set<string>()
    set.add(link.keyResultId)
    targetedKeyResults.set(link.solutionId, set)
  }

  const solutionNodes: Record<string, SolutionNode> = {}
  for (const solution of solutions) {
    const homeObjectives = new Set(objectiveIdsOf.get(solution.opportunityId) ?? [])
    const chips = [...(targetedKeyResults.get(solution.id) ?? [])]
      .sort((a, b) => (keyResultRank.get(a) ?? 0) - (keyResultRank.get(b) ?? 0))
      .map((keyResultId): KrChip => {
        const kr = keyResultById.get(keyResultId)!
        const owner = objectiveById.get(kr.objectiveId)!
        return {
          keyResultId,
          title: kr.title,
          objectiveId: owner.id,
          objectiveTitle: owner.title,
          // A pool opportunity is linked to nothing, so every chip on it is cross-outcome.
          crossOutcome: !homeObjectives.has(kr.objectiveId),
        }
      })
    solutionNodes[solution.id] = {
      id: solution.id,
      opportunityId: solution.opportunityId,
      title: solution.title,
      status: solution.status,
      krChips: chips,
    }
  }

  const keyResultsByObjective = new Map<string, TreeKeyResultInput[]>()
  for (const kr of keyResults) {
    const list = keyResultsByObjective.get(kr.objectiveId) ?? []
    list.push(kr)
    keyResultsByObjective.set(kr.objectiveId, list)
  }

  const opportunitiesByObjective = new Map<string, string[]>()
  for (const opportunity of opportunities) {
    for (const objectiveId of objectiveIdsOf.get(opportunity.id) ?? []) {
      const list = opportunitiesByObjective.get(objectiveId) ?? []
      list.push(opportunity.id)
      opportunitiesByObjective.set(objectiveId, list)
    }
  }

  const solutionsByKeyResult = new Map<string, string[]>()
  for (const solution of solutions) {
    for (const keyResultId of targetedKeyResults.get(solution.id) ?? []) {
      const list = solutionsByKeyResult.get(keyResultId) ?? []
      list.push(solution.id)
      solutionsByKeyResult.set(keyResultId, list)
    }
  }

  const roots: OutcomeRoot[] = objectives.map((objective) => {
    const own = keyResultsByObjective.get(objective.id) ?? []
    const ownKeyResultIds = new Set(own.map((kr) => kr.id))
    const linked = opportunitiesByObjective.get(objective.id) ?? []

    const children: OutcomeRootChild[] = linked.map((opportunityId) => {
      const homeId = objectiveIdsOf.get(opportunityId)![0]
      if (homeId === objective.id) return { opportunityId, placement: "home", homeObjective: null }
      const home = objectiveById.get(homeId)!
      return { opportunityId, placement: "also", homeObjective: { id: home.id, title: home.title } }
    })
    const homeOpportunityIds = children.filter((c) => c.placement === "home").map((c) => c.opportunityId)
    const homeSolutionIds = homeOpportunityIds.flatMap((id) => opportunityNodes[id].solutionIds)

    const parent = objective.parentKeyResultId ? keyResultById.get(objective.parentKeyResultId) : undefined
    const parentObjective = parent ? objectiveById.get(parent.objectiveId) : undefined

    const objectiveRooted = shape === "objective-rooted-pool"
    return {
      id: objective.id,
      title: objective.title,
      status: objective.status ?? null,
      cycle: objective.cycle ?? null,
      supports:
        parent && parentObjective
          ? { keyResultId: parent.id, keyResultTitle: parent.title, objectiveId: parentObjective.id, objectiveTitle: parentObjective.title }
          : null,
      keyResults: own.map((kr) => ({
        id: kr.id,
        title: kr.title,
        current: kr.current,
        target: kr.target,
        unit: kr.unit ?? null,
        progress: progressOf(kr.current, kr.target),
        solutionIds: objectiveRooted ? (solutionsByKeyResult.get(kr.id) ?? []) : [],
      })),
      children,
      looseSolutionIds: objectiveRooted
        ? homeSolutionIds.filter((id) => !solutionNodes[id].krChips.some((chip) => ownKeyResultIds.has(chip.keyResultId)))
        : [],
      linkedOpportunityCount: children.length,
      rollup: { opportunities: homeOpportunityIds.length, solutions: homeSolutionIds.length },
    }
  })

  return {
    shape,
    roots,
    pool,
    opportunities: opportunityNodes,
    solutions: solutionNodes,
    totals: {
      objectives: objectives.length,
      opportunities: opportunities.length,
      solutions: solutions.length,
      pool: pool.length,
    },
  }
}
