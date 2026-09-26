import getPrisma from "@/lib/db"
import type {
  MetricDirection,
  ScoringEntityType,
  ScoringFormulaType,
  ScoringModelData,
  ScoringModelStatus,
} from "@/lib/types"

/**
 * Shared resolution of "which scoring model is this workspace using?".
 *
 * Before this module the same WorkspaceScoringConfig lookup and the same
 * `modelVersion < version` staleness rule were written out inline in the
 * opportunity detail page and in the MCP scoring tool handlers. The Discovery
 * board and the opportunity side panel need both as well, so they live here
 * once. The pure projections are in `lib/score-summary.ts` (no Prisma import,
 * so client components can use them too) and are re-exported below.
 */
export {
  isScoreStale,
  toScoreSummary,
  toOpportunityScoreData,
  toSolutionScoreData,
  type ScoreSummaryRow,
  type ScoreDetailRow,
  type ActiveModel,
} from "@/lib/score-summary"

/**
 * Fetch the workspace's active scoring model for the given entity type
 * ("OPPORTUNITY" or "SOLUTION"), or null when none is configured for that
 * slot. Callers use `null` as the "render no scoring UI at all" signal.
 */
export async function resolveWorkspaceScoringModel(
  workspaceId: string,
  entityType: ScoringEntityType
): Promise<ScoringModelData | null> {
  const config = await getPrisma().workspaceScoringConfig.findUnique({
    where: { workspaceId },
    include: {
      opportunityScoringModel: { include: { metrics: { orderBy: { order: "asc" } } } },
      solutionScoringModel: { include: { metrics: { orderBy: { order: "asc" } } } },
    },
  })

  const model = entityType === "SOLUTION" ? config?.solutionScoringModel : config?.opportunityScoringModel
  if (!model) return null

  return {
    id: model.id,
    name: model.name,
    description: model.description,
    status: model.status as ScoringModelStatus,
    formulaType: model.formulaType as ScoringFormulaType,
    version: model.version,
    metrics: model.metrics.map((m) => ({
      id: m.id,
      key: m.key,
      label: m.label,
      description: m.description,
      minValue: m.minValue,
      maxValue: m.maxValue,
      weight: m.weight,
      direction: m.direction as MetricDirection,
      order: m.order,
    })),
  }
}
