import getPrisma from "@/lib/db"
import type {
  MetricDirection,
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
  type ScoreSummaryRow,
  type ScoreDetailRow,
  type ActiveModel,
} from "@/lib/score-summary"

/**
 * Fetch the workspace's active scoring model, or null when none is configured.
 * Callers use `null` as the "render no scoring UI at all" signal.
 */
export async function resolveWorkspaceScoringModel(
  workspaceId: string
): Promise<ScoringModelData | null> {
  const config = await getPrisma().workspaceScoringConfig.findUnique({
    where: { workspaceId },
    include: { scoringModel: { include: { metrics: { orderBy: { order: "asc" } } } } },
  })

  const model = config?.scoringModel
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
