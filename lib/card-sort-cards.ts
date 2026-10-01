import getPrisma from "@/lib/db"
import { resolveWorkspaceScoringModel } from "@/lib/scoring-model"
import { toScoreSummary } from "@/lib/score-summary"
import type { CustomFieldObjectType } from "@/lib/types"
import type { OpportunityScoreSummary, OpportunityStatus } from "@/lib/types"

/**
 * The extra fields a card-sort card needs to look like the object's real card.
 *
 * loadCardSortBoard deliberately returns only id + title for every object type,
 * because the sort itself needs nothing more. This is the presentation layer's
 * top-up: for opportunities it loads what components/discovery/opportunity-card
 * shows (segment, status, squad, counts, score) so the card-sort board and the
 * discovery board render the same object the same way. Other object types get
 * no meta and fall back to a title-only card — still clickable into its panel.
 */
export type CardSortCardMeta = {
  description: string | null
  status: OpportunityStatus
  squad: { id: string; name: string; color: string } | null
  solutionCount: number
  evidenceCount: number
  evidenceSourceCount: number
  score: OpportunityScoreSummary | null
}

export type CardSortCardMetaResult = {
  meta: Record<string, CardSortCardMeta>
  showScore: boolean
}

export async function loadCardSortCardMeta({
  workspaceId,
  objectType,
  objectIds,
}: {
  workspaceId: string
  objectType: CustomFieldObjectType
  objectIds: string[]
}): Promise<CardSortCardMetaResult> {
  if (objectType !== "OPPORTUNITY" || objectIds.length === 0) return { meta: {}, showScore: false }

  const prisma = getPrisma()
  const [opportunities, squads, evidenceSources, scoringModel] = await Promise.all([
    prisma.opportunity.findMany({
      where: { workspaceId, id: { in: objectIds } },
      select: {
        id: true,
        customerSegment: true,
        status: true,
        squadId: true,
        score: { select: { normalizedScore: true, modelVersion: true } },
        // Count only solutions that carry this workspace's own workspaceId, so the card agrees with the scoped Solution lists.
        _count: { select: { solutions: { where: { workspaceId } }, evidence: true } },
      },
    }),
    prisma.squad.findMany({ where: { workspaceId }, select: { id: true, name: true, color: true } }),
    prisma.evidence.groupBy({
      by: ["opportunityId", "sourceType"],
      where: { workspaceId, opportunityId: { in: objectIds } },
    }),
    resolveWorkspaceScoringModel(workspaceId, "OPPORTUNITY"),
  ])

  const squadById = new Map(squads.map((squad) => [squad.id, squad]))
  const sourceCount = new Map<string, number>()
  for (const row of evidenceSources) {
    if (!row.opportunityId) continue
    sourceCount.set(row.opportunityId, (sourceCount.get(row.opportunityId) ?? 0) + 1)
  }

  const meta: Record<string, CardSortCardMeta> = {}
  for (const opportunity of opportunities) {
    meta[opportunity.id] = {
      description: opportunity.customerSegment,
      status: opportunity.status as OpportunityStatus,
      squad: opportunity.squadId ? (squadById.get(opportunity.squadId) ?? null) : null,
      solutionCount: opportunity._count.solutions,
      evidenceCount: opportunity._count.evidence,
      evidenceSourceCount: sourceCount.get(opportunity.id) ?? 0,
      score: toScoreSummary(opportunity.score, scoringModel),
    }
  }
  return { meta, showScore: scoringModel !== null }
}
