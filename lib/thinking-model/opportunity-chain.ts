/**
 * The per-opportunity "OST" chain (Opportunity detail, OST tab).
 *
 * PURE and client-safe: the detail payload in, a plain serializable view out, no Prisma and no server imports. The
 * component only renders what this returns. It reuses the conventions of the workspace outcome tree
 * (outcome-tree.ts) instead of inventing new ones:
 *
 *  - Which levels are drawn follows the preset's link EMPHASIS, never its key: a "hidden" link means that level is
 *    not drawn. How they are laid out follows the preset's `tree` shape.
 *  - Objective parents: the typed Opportunity<->Objective links are the parents when the preset offers them. With no
 *    usable link the legacy Key Result pointer falls back to that Key Result's Objective (link rows always win).
 *    An Opportunity linked to several Objectives shows every parent once above ONE opportunity subtree.
 *  - "kr-rooted" (CLASSIC): Key Result root (its Objective title is part of the node), the Opportunity beneath it.
 *    No typed Opportunity<->Objective parents, no Solution<->Key Result chips.
 *  - "objective-rooted-pool" (OPPORTUNITY_FIRST_OKR): Objective roots. The legacy Key Result, where the preset still
 *    offers it, is a secondary node under its own Objective. Solutions carry chips for the Key Results they target.
 *  - "outcome-rooted" (TORRES_OST): Outcome roots with the Outcome's Key Results as a compact metric strip (not tree
 *    nodes). Solutions carry chips for the Key Results they target; a chip is cross-outcome when that Key Result sits
 *    under an Objective the Opportunity is not under.
 *
 * Data and authorization are identical across presets; only the presentation differs.
 */
import type { LinkEmphasis, TreeShape } from "./presets"
import type {
  AssumptionStatus,
  Conclusion,
  ExperimentStatus,
  OpportunityStatus,
  RiskLevel,
  SolutionStatus,
} from "@/lib/types"

// ─── Input ───────────────────────────────────────────────────────────────────

export type OSTExperimentNode = {
  id: string
  title: string
  status: ExperimentStatus
  conclusion: Conclusion | null
  hypothesis: string
}

export type OSTAssumptionNode = {
  id: string
  title: string
  riskLevel: RiskLevel
  status: AssumptionStatus
  experiments: OSTExperimentNode[]
}

export type ChainRoadmapInput = {
  id: string
  title: string
  horizon: string
  status?: string | null
  /** Set on the opportunity-level list so an item already shown under its Solution is not repeated. */
  solutionId?: string | null
}

export type ChainTaskInput = { id: string; title: string; status: string }

export type ChainKeyResultInput = {
  id: string
  title: string
  current?: number | null
  target?: number | null
  unit?: string | null
}

/** Supporting rows for the Objectives the chain touches, loaded workspace-scoped by the detail fetcher. */
export type ChainObjectiveInput = { id: string; title: string; keyResults?: ChainKeyResultInput[] }

export type OSTSolutionNode = {
  id: string
  title: string
  status: SolutionStatus
  assumptions: OSTAssumptionNode[]
  /** Typed Solution<->Key Result links; only loaded for presets that offer them. */
  linkedKeyResults?: Array<{ id: string; title: string; objectiveId: string }>
  roadmapItems?: ChainRoadmapInput[]
  deliveryTasks?: ChainTaskInput[]
}

export type OSTOpportunityNode = {
  id: string
  title: string
  status: OpportunityStatus
  linkedKeyResult: {
    id: string
    title: string
    objective: { id?: string; title: string }
  } | null
  /** Typed Opportunity<->Objective links (Phase 4B); drawn only by presets that offer them. */
  linkedObjectives?: Array<{ id: string; title: string }>
  chainObjectives?: ChainObjectiveInput[]
  roadmapItems?: ChainRoadmapInput[]
  deliveryTasks?: ChainTaskInput[]
  solutions: OSTSolutionNode[]
}

export type ChainModel = { links: { oppToKr: LinkEmphasis; oppToObjective: LinkEmphasis; solToKr: LinkEmphasis }; tree: TreeShape }

// ─── Output ──────────────────────────────────────────────────────────────────

export const CHAIN_TASK_CAP = 5

export type ChainMetric = { id: string; title: string; progress: number | null; current: number | null; target: number | null; unit: string | null }

export type ChainKeyResultNode = { id: string; title: string; emphasis: "primary" | "secondary" }

export type ChainParent =
  | {
      kind: "keyResult"
      id: string
      title: string
      /** The Key Result's Objective title is part of the CLASSIC root node. id is null when the payload did not carry it. */
      objective: { id: string | null; title: string }
    }
  | {
      kind: "objective"
      /** Null only for a fallback parent whose id the payload did not carry; rendered but not clickable. */
      id: string | null
      title: string
      keyResults: ChainKeyResultNode[]
      metrics: ChainMetric[]
    }

export type ChainRoadmapItem = { id: string; title: string; horizon: string }
export type ChainTask = { id: string; title: string; status: string }
export type ChainTasks = { items: ChainTask[]; more: number }

export type ChainKrChip = { id: string; title: string; crossOutcome: boolean; objectiveTitle: string | null }

export type ChainSolution = {
  id: string
  title: string
  status: SolutionStatus
  krChips: ChainKrChip[]
  roadmapItems: ChainRoadmapItem[]
  tasks: ChainTasks
  assumptions: OSTAssumptionNode[]
}

export type ChainOpportunity = {
  id: string
  title: string
  status: OpportunityStatus
  roadmapItems: ChainRoadmapItem[]
  tasks: ChainTasks
  solutions: ChainSolution[]
}

export type ChainLegendKind = "root" | "objective" | "keyResult" | "opportunity" | "solution" | "assumption" | "experiment" | "roadmapItem" | "task"

export type OpportunityChain = {
  shape: TreeShape
  parents: ChainParent[]
  opportunity: ChainOpportunity
  /** Node kinds in drawing order. "root" is the CLASSIC Key Result root, labelled by the caller. */
  legend: ChainLegendKind[]
}

// ─── Derivation ──────────────────────────────────────────────────────────────

const progressOf = (current: number | null | undefined, target: number | null | undefined): number | null =>
  typeof current === "number" && typeof target === "number" && target > 0 ? Math.max(0, Math.min(1, current / target)) : null

const liveRoadmap = (items: readonly ChainRoadmapInput[] | undefined): ChainRoadmapInput[] =>
  (items ?? []).filter((item) => item.status !== "ARCHIVED")

const toRoadmapItem = ({ id, title, horizon }: ChainRoadmapInput): ChainRoadmapItem => ({ id, title, horizon })

function capTasks(tasks: readonly ChainTaskInput[] | undefined): ChainTasks {
  const all = tasks ?? []
  return { items: all.slice(0, CHAIN_TASK_CAP).map(({ id, title, status }) => ({ id, title, status })), more: Math.max(0, all.length - CHAIN_TASK_CAP) }
}

export function buildOpportunityChain(opportunity: OSTOpportunityNode, model: ChainModel): OpportunityChain {
  const { links, tree } = model
  // The legacy pointer. Even when the Key Result itself is not drawn it still decides the Objective fallback (link rows win).
  const legacyKr = opportunity.linkedKeyResult
  const objectiveTitles = new Map<string, string>()
  const objectiveKeyResults = new Map<string, ChainKeyResultInput[]>()
  for (const objective of opportunity.chainObjectives ?? []) {
    objectiveTitles.set(objective.id, objective.title)
    objectiveKeyResults.set(objective.id, objective.keyResults ?? [])
  }

  // ── Parents ──
  const parents: ChainParent[] = []
  const parentObjectiveIds = new Set<string>()

  if (tree === "kr-rooted") {
    if (legacyKr && links.oppToKr !== "hidden") {
      parents.push({
        kind: "keyResult",
        id: legacyKr.id,
        title: legacyKr.title,
        objective: { id: legacyKr.objective.id ?? null, title: legacyKr.objective.title },
      })
    }
  } else {
    const linked = links.oppToObjective !== "hidden" ? (opportunity.linkedObjectives ?? []) : []
    const seen = new Set<string>()
    const objectiveParents: Array<{ id: string | null; title: string }> = []
    for (const objective of linked) {
      if (seen.has(objective.id)) continue
      seen.add(objective.id)
      objectiveParents.push({ id: objective.id, title: objective.title })
    }
    if (objectiveParents.length === 0 && legacyKr) {
      const id = legacyKr.objective.id ?? null
      objectiveParents.push({ id, title: legacyKr.objective.title })
    }
    // The pool shape keeps a visible legacy Key Result under its own Objective, even one the links do not name.
    const showKrNode = tree === "objective-rooted-pool" && links.oppToKr !== "hidden" && opportunity.linkedKeyResult !== null
    const owner = showKrNode ? opportunity.linkedKeyResult!.objective : null
    if (owner) {
      if (owner.id && !objectiveParents.some((p) => p.id === owner.id)) objectiveParents.push({ id: owner.id, title: owner.title })
    }
    for (const parent of objectiveParents) {
      if (parent.id) parentObjectiveIds.add(parent.id)
      // An id-less fallback parent IS the legacy Key Result's own Objective.
      const ownsKr = showKrNode && (parent.id === null || owner?.id === parent.id)
      const keyResults: ChainKeyResultNode[] = ownsKr
        ? [{ id: opportunity.linkedKeyResult!.id, title: opportunity.linkedKeyResult!.title, emphasis: links.oppToKr === "primary" ? "primary" : "secondary" }]
        : []
      const metrics: ChainMetric[] =
        tree === "outcome-rooted" && parent.id
          ? (objectiveKeyResults.get(parent.id) ?? []).map((kr) => ({
              id: kr.id,
              title: kr.title,
              progress: progressOf(kr.current, kr.target),
              current: kr.current ?? null,
              target: kr.target ?? null,
              unit: kr.unit ?? null,
            }))
          : []
      parents.push({ kind: "objective", id: parent.id, title: objectiveTitles.get(parent.id ?? "") ?? parent.title, keyResults, metrics })
    }
  }

  // ── Solutions ──
  const showChips = links.solToKr !== "hidden"
  const solutionIds = new Set(opportunity.solutions.map((s) => s.id))
  const solutions: ChainSolution[] = opportunity.solutions.map((solution) => ({
    id: solution.id,
    title: solution.title,
    status: solution.status,
    krChips: showChips
      ? (solution.linkedKeyResults ?? []).map((kr) => ({
          id: kr.id,
          title: kr.title,
          // A pool opportunity is under no Objective, so every chip on it is cross-outcome (outcome-tree.ts).
          crossOutcome: !parentObjectiveIds.has(kr.objectiveId),
          objectiveTitle: objectiveTitles.get(kr.objectiveId) ?? null,
        }))
      : [],
    roadmapItems: liveRoadmap(solution.roadmapItems).map(toRoadmapItem),
    tasks: capTasks(solution.deliveryTasks),
    assumptions: solution.assumptions,
  }))

  const shownUnderSolution = new Set(solutions.flatMap((s) => s.roadmapItems.map((r) => r.id)))
  const opportunityRoadmap = liveRoadmap(opportunity.roadmapItems).filter(
    (item) => !shownUnderSolution.has(item.id) && !(item.solutionId && solutionIds.has(item.solutionId)),
  )

  const chain: ChainOpportunity = {
    id: opportunity.id,
    title: opportunity.title,
    status: opportunity.status,
    roadmapItems: opportunityRoadmap.map(toRoadmapItem),
    tasks: capTasks(opportunity.deliveryTasks),
    solutions,
  }

  // ── Legend ──
  const legend: ChainLegendKind[] = tree === "kr-rooted" ? ["root"] : ["objective", "keyResult"]
  legend.push("opportunity", "solution", "assumption", "experiment")
  if (chain.roadmapItems.length > 0 || solutions.some((s) => s.roadmapItems.length > 0)) legend.push("roadmapItem")
  if (chain.tasks.items.length > 0 || solutions.some((s) => s.tasks.items.length > 0)) legend.push("task")

  return { shape: tree, parents, opportunity: chain, legend }
}
