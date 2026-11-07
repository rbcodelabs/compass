/**
 * The read-only "Linked opportunities" list on the Objective detail panel.
 *
 * `assembleLinkedOpportunities` is pure (no database): it merges the opportunities linked DIRECTLY to an objective with those linked
 * through the objective's key results, dedupes by id, and orders them. `loadObjectiveLinkedOpportunities` is the thin loader that reads
 * the rows (workspace-filtered) and calls it. Scores are the stored OpportunityScore rows, never recomputed: the headline number is the
 * RAW score (multiplicative models reach 5000, where the 0-100 normalized value looks tiny); the normalized value is carried only as a
 * secondary. With no active Opportunity scoring model every score field is omitted and the list sorts by status then title.
 */
import type { AppPrismaClient } from "@/lib/db"
import { isScoreStale } from "@/lib/score-summary"
import { resolveWorkspaceScoringModel } from "@/lib/scoring-model"
import { getLinkedOpportunitiesByObjective } from "@/lib/typed-links"

export type LinkedOpportunityInput = {
  id: string
  title: string
  status: string
  score: { rawScore: number; normalizedScore: number; modelVersion: number } | null
}

export type LinkedOpportunityRow = {
  id: string
  title: string
  status: string
  /** Linked straight to the objective. */
  direct: boolean
  /** The key results of this objective that also carry the opportunity (empty when only linked directly). */
  viaKeyResults: { id: string; title: string }[]
  /** Present only when the workspace has an active Opportunity scoring model; null = not scored. */
  rawScore?: number | null
  normalizedScore?: number | null
  scoreStale?: boolean
}

export type LinkedOpportunities = { scoringActive: boolean; items: LinkedOpportunityRow[] }

export type AssembleInput = {
  direct: readonly LinkedOpportunityInput[]
  viaKeyResults: readonly { keyResult: { id: string; title: string }; opportunities: readonly LinkedOpportunityInput[] }[]
  /** The active Opportunity model's live version; null when the workspace has none. */
  liveModelVersion: number | null
}

const STATUS_RANK: Record<string, number> = { ACTIVE: 0, PRIORITIZED: 1, VALIDATING: 2, EXPLORING: 3, ARCHIVED: 4 }
const rank = (status: string) => STATUS_RANK[status] ?? 99

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const byTitleThenId = (a: LinkedOpportunityRow, b: LinkedOpportunityRow) =>
  a.title.localeCompare(b.title, "en") || byText(a.id, b.id)

export function assembleLinkedOpportunities(input: AssembleInput): LinkedOpportunities {
  const scoringActive = input.liveModelVersion !== null
  const byId = new Map<string, { source: LinkedOpportunityInput; direct: boolean; krs: Map<string, { id: string; title: string }> }>()
  const entry = (source: LinkedOpportunityInput) => {
    let found = byId.get(source.id)
    if (!found) byId.set(source.id, (found = { source, direct: false, krs: new Map() }))
    return found
  }
  for (const opportunity of input.direct) entry(opportunity).direct = true
  for (const { keyResult, opportunities } of input.viaKeyResults) {
    for (const opportunity of opportunities) entry(opportunity).krs.set(keyResult.id, keyResult)
  }

  const items: LinkedOpportunityRow[] = [...byId.values()].map(({ source, direct, krs }) => {
    const row: LinkedOpportunityRow = {
      id: source.id,
      title: source.title,
      status: source.status,
      direct,
      viaKeyResults: [...krs.values()].sort((a, b) => a.title.localeCompare(b.title, "en") || byText(a.id, b.id)),
    }
    if (input.liveModelVersion !== null) {
      row.rawScore = source.score?.rawScore ?? null
      row.normalizedScore = source.score?.normalizedScore ?? null
      row.scoreStale = source.score ? isScoreStale(source.score.modelVersion, input.liveModelVersion) : false
    }
    return row
  })

  items.sort((a, b) => {
    if (scoringActive) {
      const aScored = a.rawScore != null
      const bScored = b.rawScore != null
      if (aScored !== bScored) return aScored ? -1 : 1
      if (aScored && bScored && a.rawScore !== b.rawScore) return (b.rawScore as number) - (a.rawScore as number)
      return byTitleThenId(a, b)
    }
    return rank(a.status) - rank(b.status) || byTitleThenId(a, b)
  })
  return { scoringActive, items }
}

/**
 * Load and assemble. `includeDirect` / `includeViaKeyResults` follow the workspace's thinking-model link emphasis (a preset that
 * hides a link kind never shows it here). The caller already read the objective under this workspace's filter.
 */
export async function loadObjectiveLinkedOpportunities(
  db: AppPrismaClient,
  workspaceId: string,
  objective: { id: string; keyResults: readonly { id: string; title: string }[] },
  options: { includeDirect: boolean; includeViaKeyResults: boolean },
): Promise<LinkedOpportunities> {
  const directLinks = options.includeDirect
    ? ((await getLinkedOpportunitiesByObjective(db, workspaceId, [objective.id], { preverified: true })).get(objective.id) ?? [])
    : []
  const krIds = options.includeViaKeyResults ? objective.keyResults.map((kr) => kr.id) : []
  const krLinked = krIds.length
    ? await db.opportunity.findMany({ where: { workspaceId, linkedKeyResultId: { in: krIds } }, select: { id: true, linkedKeyResultId: true } })
    : []

  const ids = [...new Set([...directLinks.map((o) => o.id), ...krLinked.map((o) => o.id)])]
  const model = await resolveWorkspaceScoringModel(workspaceId, "OPPORTUNITY")
  const rows = ids.length
    ? await db.opportunity.findMany({
        where: { id: { in: ids }, workspaceId },
        select: { id: true, title: true, status: true, score: { select: { rawScore: true, normalizedScore: true, modelVersion: true } } },
      })
    : []
  const inputs = new Map<string, LinkedOpportunityInput>(rows.map((row) => [row.id, { id: row.id, title: row.title, status: row.status, score: row.score }]))

  const direct = directLinks.flatMap((o) => inputs.get(o.id) ?? [])
  const viaKeyResults = objective.keyResults.map((keyResult) => ({
    keyResult,
    opportunities: krLinked.filter((o) => o.linkedKeyResultId === keyResult.id).flatMap((o) => inputs.get(o.id) ?? []),
  }))
  return assembleLinkedOpportunities({ direct, viaKeyResults, liveModelVersion: model ? model.version : null })
}
