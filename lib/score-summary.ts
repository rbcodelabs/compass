import type {
  FormulaSnapshotMetric,
  OpportunityScoreData,
  OpportunityScoreSummary,
  ScoringModelData,
} from "@/lib/types"

/**
 * Pure score projections and the single staleness rule.
 *
 * Deliberately free of any Prisma import so client components (the opportunity
 * side panel) can share exactly the same derivation as the server surfaces.
 * The Prisma-backed model lookup lives in `lib/scoring-model.ts`, which
 * re-exports everything here.
 */

/** The OpportunityScore columns a board/list/panel surface needs. */
export type ScoreSummaryRow = {
  normalizedScore: number
  modelVersion: number
}

/** The OpportunityScore columns the detail page's Scoring tab needs. */
export type ScoreDetailRow = ScoreSummaryRow & {
  id: string
  scoringModelId: string
  formulaSnapshot: unknown
  rawValues: unknown
  rawScore: number
  scoredAt: Date
}

/** The parts of the active model these projections depend on. */
export type ActiveModel = Pick<ScoringModelData, "name" | "formulaType" | "version">

/**
 * A score is stale when it was saved under an older version of the model than
 * the one that is live now. Equal or ahead (which should not happen) is fresh.
 */
export function isScoreStale(scoredModelVersion: number, liveModelVersion: number): boolean {
  return scoredModelVersion < liveModelVersion
}

/**
 * Narrow a score row to the board/panel projection. Returns null when there is
 * no score row or no active model — both mean "render no score".
 */
export function toScoreSummary(
  row: ScoreSummaryRow | null | undefined,
  model: Pick<ActiveModel, "version"> | null | undefined
): OpportunityScoreSummary | null {
  if (!row || !model) return null
  return {
    normalizedScore: row.normalizedScore,
    modelVersion: row.modelVersion,
    liveModelVersion: model.version,
    stale: isScoreStale(row.modelVersion, model.version),
  }
}

/** Expand a score row into the full detail-page projection. */
export function toOpportunityScoreData(
  row: ScoreDetailRow | null | undefined,
  model: ActiveModel | null | undefined
): OpportunityScoreData | null {
  if (!row || !model) return null
  return {
    id: row.id,
    scoringModelId: row.scoringModelId,
    scoringModelName: model.name,
    modelVersion: row.modelVersion,
    formulaType: model.formulaType,
    formulaSnapshot: row.formulaSnapshot as FormulaSnapshotMetric[],
    rawValues: row.rawValues as Record<string, number>,
    rawScore: row.rawScore,
    normalizedScore: row.normalizedScore,
    scoredAt: row.scoredAt.toISOString(),
    stale: isScoreStale(row.modelVersion, model.version),
  }
}

/**
 * Solution scoring is a structural mirror of Opportunity scoring — a
 * SolutionScore row and an OpportunityScore row project identically (see
 * SolutionScoreData in lib/types.ts), so this is a neutral-name alias rather
 * than a duplicate implementation.
 */
export const toSolutionScoreData = toOpportunityScoreData
