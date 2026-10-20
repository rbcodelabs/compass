/**
 * Pure shaping for the Product Spec Canvas: a read-only, top-to-bottom document
 * lens over one Opportunity and the records hanging off it. Nothing here is
 * persisted; the canvas is rebuilt from live rows on every request.
 *
 * Dependency-free on purpose (no Prisma, no `next/*`) so the ordering, grouping
 * and de-duplication rules are unit-testable without a database. The loader in
 * ./load.ts fetches workspace-scoped rows and hands them to `shapeSpecCanvas`.
 */
import { displayIdFromRow } from "@/lib/work-item-ids"
import { entityPath } from "@/lib/entity-links"
import type { ArtifactThumbnailDto } from "@/lib/artifacts"
import type { ResolvedLabels } from "@/lib/thinking-model/labels"

export type SpecTone = "neutral" | "info" | "success" | "warning" | "danger"

export const SPEC_SECTION_IDS = {
  outcome: "spec-outcome",
  opportunity: "spec-opportunity",
  solutions: "spec-solutions",
  assumptions: "spec-assumptions",
  experiments: "spec-experiments",
  prototypes: "spec-prototypes",
} as const
export type SpecSectionKey = keyof typeof SPEC_SECTION_IDS

type SeqFields = { seqPrefix: string | null; seqNumber: number | null }

// ── Raw rows (what the loader selects) ───────────────────────────────────────

export type RawKeyResult = { id: string; title: string; current: number; target: number; unit: string | null; objectiveId: string } & Partial<SeqFields>
export type RawObjective = { id: string; title: string; description: string | null; status: string } & Partial<SeqFields>
export type RawExperiment = {
  id: string; title: string; hypothesis: string; status: string; conclusion: string | null
  conclusionReason: string | null; assumptionId: string | null
} & Partial<SeqFields>
export type RawAssumption = {
  id: string; title: string; description: string | null; riskLevel: string; status: string
  experiments: RawExperiment[]
} & Partial<SeqFields>
export type RawSolution = {
  id: string; title: string; description: string | null; status: string
  assumptions: RawAssumption[]
} & Partial<SeqFields>
export type RawEvidence = { id: string; sourceType: string; excerpt: string; confidence: string; sourceUrl: string | null }
export type RawArtifact = {
  id: string; title: string; description: string | null; sourceType: string; kind: string | null
  externalUrl: string | null; thumbnail: ArtifactThumbnailDto | null
  /** Sandbox-wrapped HTML, present only for the few artifacts the loader chose to frame inline. */
  previewHtml?: string | null
} & Partial<SeqFields>

export type RawSpecCanvas = {
  opportunity: {
    id: string; title: string; description: string | null; status: string; customerSegment: string | null
  } & Partial<SeqFields>
  evidence: RawEvidence[]
  /** Objectives from typed links, plus the Objective of the legacy `linkedKeyResultId` column. */
  objectives: RawObjective[]
  /** The legacy `Opportunity.linkedKeyResultId` Key Result, if any (already workspace-verified). */
  opportunityKeyResult: RawKeyResult | null
  solutions: RawSolution[]
  /** solutionId -> Key Results linked through solution_key_result_links. */
  solutionKeyResults: ReadonlyMap<string, RawKeyResult[]>
  /** solutionId -> artifacts linked to that solution. */
  solutionArtifacts: ReadonlyMap<string, RawArtifact[]>
}

// ── Shaped output ────────────────────────────────────────────────────────────

export type SpecKeyResult = {
  id: string; title: string; href: string; current: number; target: number; unit: string | null
  /** 0..1, or null when the target is not a positive number. */
  progress: number | null
  /** What ties this Key Result to the opportunity: the opportunity itself and/or titles of solutions. */
  linkedVia: { opportunity: boolean; solutionTitles: string[] }
}
export type SpecObjective = {
  id: string; displayId: string | null; title: string; description: string | null; status: string; href: string
  keyResults: SpecKeyResult[]
}
export type SpecEvidence = RawEvidence
export type SpecExperiment = {
  id: string; displayId: string | null; title: string; hypothesis: string; href: string
  status: string; statusTone: SpecTone; conclusion: string | null; conclusionTone: SpecTone | null; conclusionReason: string | null
  assumptionId: string; assumptionTitle: string
}
export type SpecAssumption = {
  id: string; displayId: string | null; title: string; description: string | null; href: string
  riskLevel: string; riskTone: SpecTone; status: string; statusTone: SpecTone
  solutionId: string; solutionTitle: string; experimentCount: number
}
export type SpecSolution = {
  id: string; displayId: string | null; title: string; description: string | null; href: string
  status: string; statusTone: SpecTone; assumptionCount: number; artifactCount: number
}
export type SpecArtifact = {
  id: string; displayId: string | null; title: string; description: string | null; href: string
  sourceType: string; kind: string | null; externalUrl: string | null
  thumbnail: ArtifactThumbnailDto | null; previewHtml: string | null
  solutionTitles: string[]
}

export type SpecCanvas = {
  opportunity: {
    id: string; displayId: string | null; title: string; description: string | null; status: string
    statusTone: SpecTone; customerSegment: string | null; href: string
  }
  evidence: SpecEvidence[]
  objectives: SpecObjective[]
  solutions: SpecSolution[]
  assumptions: SpecAssumption[]
  experiments: SpecExperiment[]
  artifacts: SpecArtifact[]
}

// ── Tone mapping (semantic status tokens only; no raw palette classes) ────────

const OPPORTUNITY_TONE: Record<string, SpecTone> = { EXPLORING: "info", VALIDATING: "warning", PRIORITIZED: "info", ACTIVE: "success", ARCHIVED: "neutral" }
const SOLUTION_TONE: Record<string, SpecTone> = { IDEA: "neutral", VALIDATED: "success", IN_DELIVERY: "info", SHIPPED: "success", KILLED: "danger" }
const ASSUMPTION_TONE: Record<string, SpecTone> = { UNTESTED: "neutral", TESTING: "warning", VALIDATED: "success", INVALIDATED: "danger" }
const RISK_TONE: Record<string, SpecTone> = { HIGH: "danger", MEDIUM: "warning", LOW: "success" }
const EXPERIMENT_TONE: Record<string, SpecTone> = { DESIGNING: "neutral", RUNNING: "info", COMPLETE: "success", KILLED: "danger", NOT_PURSUED: "neutral" }
const CONCLUSION_TONE: Record<string, SpecTone> = { PROCEED: "success", KILL: "danger", ITERATE: "warning", NOT_PURSUED: "neutral" }

const toneOf = (table: Record<string, SpecTone>, value: string): SpecTone => table[value] ?? "neutral"

/** `IN_DELIVERY` -> `In delivery`. Unknown values still render readably. */
export function humanizeEnum(value: string): string {
  const spaced = value.toLowerCase().replace(/_/g, " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ── Ordering helpers ─────────────────────────────────────────────────────────

const RISK_ORDER: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 }
const EXPERIMENT_ORDER: Record<string, number> = { RUNNING: 0, DESIGNING: 1, COMPLETE: 2, KILLED: 3, NOT_PURSUED: 4 }

/** Stable sort by a rank table; values missing from the table sort last, ties keep input order. */
export function stableSortByRank<T>(items: readonly T[], rank: (item: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.item)
}

/** Riskiest first: that is the order a reviewer needs to read assumptions in. */
export const orderAssumptionsByRisk = <T extends { riskLevel: string }>(items: readonly T[]) =>
  stableSortByRank(items, (a) => RISK_ORDER[a.riskLevel] ?? 99)

/** In-flight work first, then finished, then abandoned. */
export const orderExperimentsByProgress = <T extends { status: string }>(items: readonly T[]) =>
  stableSortByRank(items, (e) => EXPERIMENT_ORDER[e.status] ?? 99)

export function keyResultProgress(current: number, target: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) return null
  return Math.min(1, Math.max(0, current / target))
}

// ── Shaping ──────────────────────────────────────────────────────────────────

type Slugs = { orgSlug: string; workspaceSlug: string }

export function shapeSpecCanvas(raw: RawSpecCanvas, slugs: Slugs): SpecCanvas {
  const opp = raw.opportunity
  const link = (type: Parameters<typeof entityPath>[0]["type"], row: { id: string } & Partial<SeqFields>, extra: { opportunityId?: string } = {}) =>
    entityPath({ ...slugs, type, id: row.id, displayId: displayIdFromRow(type as never, row), ...extra })

  // Key Results, keyed by id, remembering every way they tie back to this opportunity.
  const krIndex = new Map<string, { kr: RawKeyResult; viaOpportunity: boolean; solutionTitles: string[] }>()
  const touchKr = (kr: RawKeyResult) => {
    const existing = krIndex.get(kr.id)
    if (existing) return existing
    const created = { kr, viaOpportunity: false, solutionTitles: [] as string[] }
    krIndex.set(kr.id, created)
    return created
  }
  if (raw.opportunityKeyResult) touchKr(raw.opportunityKeyResult).viaOpportunity = true
  for (const solution of raw.solutions) {
    for (const kr of raw.solutionKeyResults.get(solution.id) ?? []) {
      const entry = touchKr(kr)
      if (!entry.solutionTitles.includes(solution.title)) entry.solutionTitles.push(solution.title)
    }
  }

  const objectives: SpecObjective[] = raw.objectives.map((objective) => ({
    id: objective.id,
    displayId: displayIdFromRow("objective", objective),
    title: objective.title,
    description: objective.description,
    status: objective.status,
    href: link("objective", objective),
    keyResults: [...krIndex.values()]
      .filter((entry) => entry.kr.objectiveId === objective.id)
      .map(({ kr, viaOpportunity, solutionTitles }) => ({
        id: kr.id,
        title: kr.title,
        href: link("keyResult", kr),
        current: kr.current,
        target: kr.target,
        unit: kr.unit,
        progress: keyResultProgress(kr.current, kr.target),
        linkedVia: { opportunity: viaOpportunity, solutionTitles },
      })),
  }))

  const solutions: SpecSolution[] = []
  const assumptions: SpecAssumption[] = []
  const experiments: SpecExperiment[] = []
  for (const solution of raw.solutions) {
    solutions.push({
      id: solution.id,
      displayId: displayIdFromRow("solution", solution),
      title: solution.title,
      description: solution.description,
      href: link("solution", solution, { opportunityId: opp.id }),
      status: solution.status,
      statusTone: toneOf(SOLUTION_TONE, solution.status),
      assumptionCount: solution.assumptions.length,
      artifactCount: (raw.solutionArtifacts.get(solution.id) ?? []).length,
    })
    for (const assumption of solution.assumptions) {
      assumptions.push({
        id: assumption.id,
        displayId: displayIdFromRow("assumption", assumption),
        title: assumption.title,
        description: assumption.description,
        href: link("assumption", assumption, { opportunityId: opp.id }),
        riskLevel: assumption.riskLevel,
        riskTone: toneOf(RISK_TONE, assumption.riskLevel),
        status: assumption.status,
        statusTone: toneOf(ASSUMPTION_TONE, assumption.status),
        solutionId: solution.id,
        solutionTitle: solution.title,
        experimentCount: assumption.experiments.length,
      })
      for (const experiment of assumption.experiments) {
        experiments.push({
          id: experiment.id,
          displayId: displayIdFromRow("experiment", experiment),
          title: experiment.title,
          hypothesis: experiment.hypothesis,
          href: link("experiment", experiment),
          status: experiment.status,
          statusTone: toneOf(EXPERIMENT_TONE, experiment.status),
          conclusion: experiment.conclusion,
          conclusionTone: experiment.conclusion ? toneOf(CONCLUSION_TONE, experiment.conclusion) : null,
          conclusionReason: experiment.conclusionReason,
          assumptionId: assumption.id,
          assumptionTitle: assumption.title,
        })
      }
    }
  }

  // An artifact linked to several solutions is one prototype, not several.
  const artifactIndex = new Map<string, SpecArtifact>()
  for (const solution of raw.solutions) {
    for (const artifact of raw.solutionArtifacts.get(solution.id) ?? []) {
      const existing = artifactIndex.get(artifact.id)
      if (existing) {
        if (!existing.solutionTitles.includes(solution.title)) existing.solutionTitles.push(solution.title)
        continue
      }
      artifactIndex.set(artifact.id, {
        id: artifact.id,
        displayId: displayIdFromRow("artifact", artifact),
        title: artifact.title,
        description: artifact.description,
        href: link("artifact", artifact),
        sourceType: artifact.sourceType,
        kind: artifact.kind,
        externalUrl: artifact.externalUrl,
        thumbnail: artifact.thumbnail,
        previewHtml: artifact.previewHtml ?? null,
        solutionTitles: [solution.title],
      })
    }
  }

  return {
    opportunity: {
      id: opp.id,
      displayId: displayIdFromRow("opportunity", opp),
      title: opp.title,
      description: opp.description,
      status: opp.status,
      statusTone: toneOf(OPPORTUNITY_TONE, opp.status),
      customerSegment: opp.customerSegment,
      href: link("opportunity", opp),
    },
    evidence: raw.evidence,
    objectives,
    solutions,
    assumptions: orderAssumptionsByRisk(assumptions),
    experiments: orderExperimentsByProgress(experiments),
    artifacts: [...artifactIndex.values()],
  }
}

// ── Traceability rail ────────────────────────────────────────────────────────

export type RailItem = {
  key: SpecSectionKey
  /** DOM id of the section, used for the `#anchor` link and the in-view highlight. */
  anchorId: string
  label: string
  count: number
}

/**
 * The chain the rail walks, outcome to prototype. Labels come from the
 * workspace's thinking model; sections with nothing in them are kept (count 0)
 * so a gap in the chain is visible instead of silently collapsing.
 */
export function buildTraceabilityRail(spec: SpecCanvas, labels: Pick<ResolvedLabels, "objective" | "keyResult" | "opportunity" | "solution">): RailItem[] {
  const keyResultCount = spec.objectives.reduce((sum, objective) => sum + objective.keyResults.length, 0)
  const item = (key: SpecSectionKey, label: string, count: number): RailItem => ({ key, anchorId: SPEC_SECTION_IDS[key], label, count })
  return [
    item("outcome", `${labels.objective.plural} & ${labels.keyResult.plural}`, spec.objectives.length + keyResultCount),
    item("opportunity", labels.opportunity.singular, 1),
    item("solutions", labels.solution.plural, spec.solutions.length),
    item("assumptions", "Assumptions", spec.assumptions.length),
    item("experiments", "Experiments", spec.experiments.length),
    item("prototypes", "Prototypes", spec.artifacts.length),
  ]
}
