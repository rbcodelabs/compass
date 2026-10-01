/**
 * Creating an opportunity together with its optional links — a squad, the Key
 * Result it drives, and the feedback items that seeded it.
 *
 * Shared by the `createOpportunity` action and the opportunity composer's
 * `createOpportunityFromComposer`. Every link is checked against the
 * workspace, and the opportunity row, its KR link and every feedback link are
 * written in one transaction: either all of it lands, or none of it does.
 */
import type { AppPrismaClient } from "@/lib/db"
import { feedbackOpportunityLinkData } from "@/lib/feedback"
import {
  OPPORTUNITY_LINK_OBJECTIVES_MAX,
  OPPORTUNITY_SEED_FEEDBACK_MAX,
  OPPORTUNITY_SEGMENT_MAX_LENGTH,
  OPPORTUNITY_TITLE_MAX_LENGTH,
  isNewOpportunityStatus,
  type NewOpportunityStatus,
} from "@/lib/opportunity-draft"
import { TypedLinkError, linkOpportunityToObjective, syncLegacyLink } from "@/lib/typed-links"
import { captureWorkspaceMutation } from "@/lib/workspace-update-mutations"

export type NewOpportunityInput = {
  title: string
  description?: string | null
  customerSegment?: string | null
  status?: string
  squadId?: string | null
  linkedKeyResultId?: string | null
  feedbackIds?: string[]
  /** Objectives to link (DIRECT) in the same transaction (Phase 4B). The legacy `linkedKeyResultId` behavior is unchanged. */
  objectiveIds?: string[]
}

export type NormalizedOpportunityInput = {
  title: string
  description: string | null
  customerSegment: string | null
  status: NewOpportunityStatus
  squadId: string | null
  linkedKeyResultId: string | null
  feedbackIds: string[]
  objectiveIds: string[]
}

/** A validation failure whose message is safe to show the user as-is. */
export class OpportunityCreateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OpportunityCreateError"
  }
}

const blankToNull = (value: string | null | undefined) => {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimmed : null
}

export function normalizeNewOpportunityInput(
  input: NewOpportunityInput,
): { ok: true; data: NormalizedOpportunityInput } | { ok: false; error: string } {
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!title) return { ok: false, error: "Add a title so your team can scan this at a glance." }
  if (title.length > OPPORTUNITY_TITLE_MAX_LENGTH) {
    return { ok: false, error: `Title must be ${OPPORTUNITY_TITLE_MAX_LENGTH} characters or fewer.` }
  }
  const customerSegment = blankToNull(input.customerSegment)
  if (customerSegment && customerSegment.length > OPPORTUNITY_SEGMENT_MAX_LENGTH) {
    return { ok: false, error: `Customer segment must be ${OPPORTUNITY_SEGMENT_MAX_LENGTH} characters or fewer.` }
  }
  const status = input.status ?? "EXPLORING"
  if (!isNewOpportunityStatus(status)) return { ok: false, error: "Choose a valid starting status." }
  const feedbackIds = [...new Set((input.feedbackIds ?? []).filter((id) => typeof id === "string" && id))]
  if (feedbackIds.length > OPPORTUNITY_SEED_FEEDBACK_MAX) {
    return { ok: false, error: `Seed from at most ${OPPORTUNITY_SEED_FEEDBACK_MAX} feedback items.` }
  }
  const objectiveIds = [...new Set((input.objectiveIds ?? []).filter((id) => typeof id === "string" && id))]
  if (objectiveIds.length > OPPORTUNITY_LINK_OBJECTIVES_MAX) {
    return { ok: false, error: `Link at most ${OPPORTUNITY_LINK_OBJECTIVES_MAX} items when creating.` }
  }
  return {
    ok: true,
    data: {
      title,
      description: blankToNull(input.description),
      customerSegment,
      status,
      squadId: blankToNull(input.squadId),
      linkedKeyResultId: blankToNull(input.linkedKeyResultId),
      feedbackIds,
      objectiveIds,
    },
  }
}

/** Who made the links created alongside the opportunity; the caller resolves it (this module has no session). */
export type OpportunityCreateContext = { createdById?: string | null }

/**
 * Throws `OpportunityCreateError` for invalid input or a link outside the
 * workspace; the transaction is rolled back, so nothing is written.
 * The caller is responsible for the workspace-membership check.
 */
export async function createOpportunityWithLinks(
  prisma: AppPrismaClient,
  workspaceId: string,
  input: NewOpportunityInput,
  context: OpportunityCreateContext = {},
) {
  const normalized = normalizeNewOpportunityInput(input)
  if (!normalized.ok) throw new OpportunityCreateError(normalized.error)
  const { feedbackIds, objectiveIds, ...fields } = normalized.data

  return captureWorkspaceMutation(
    prisma,
    "opportunity",
    "create",
    "UI",
    undefined,
    async (tx) => {
      // Checked inside the transaction so a check and its write see the same
      // snapshot; a failure throws and rolls back everything before it.
      if (fields.squadId && !(await tx.squad.findFirst({ where: { id: fields.squadId, workspaceId }, select: { id: true } }))) {
        throw new OpportunityCreateError("That squad is not in this workspace.")
      }
      if (
        fields.linkedKeyResultId &&
        !(await tx.keyResult.findFirst({
          where: { id: fields.linkedKeyResultId, objective: { workspaceId } },
          select: { id: true },
        }))
      ) {
        throw new OpportunityCreateError("That key result is not in this workspace.")
      }
      if (objectiveIds.length > 0) {
        const found = await tx.objective.findMany({ where: { id: { in: objectiveIds }, workspaceId }, select: { id: true } })
        if (found.length !== objectiveIds.length) {
          throw new OpportunityCreateError("One or more of the selected links are not in this workspace. Nothing was created.")
        }
      }
      if (feedbackIds.length > 0) {
        const found = await tx.feedbackItem.findMany({ where: { id: { in: feedbackIds }, workspaceId }, select: { id: true } })
        if (found.length !== feedbackIds.length) {
          throw new OpportunityCreateError("One or more feedback items are not in this workspace. Nothing was created.")
        }
      }

      const opportunity = await tx.opportunity.create({ data: { workspaceId, ...fields } })

      // Dual-write: the legacy pointer's LEGACY Opportunity<->Objective link, in this same transaction.
      if (fields.linkedKeyResultId) {
        await syncLegacyLink(tx, {
          opportunityId: opportunity.id,
          workspaceId,
          keyResultId: fields.linkedKeyResultId,
          // Derived from the pointer, so unattributed: it is not a link anyone chose to make.
          ctx: { source: "UI", createdById: null },
        })
      }

      // Typed Opportunity<->Objective links the author chose: DIRECT, in this same transaction, through the typed-link module.
      // Run after the legacy sync, so an Objective that is also the pointer's own flips its LEGACY link to DIRECT (a deliberate choice).
      for (const objectiveId of objectiveIds) {
        try {
          await linkOpportunityToObjective(tx, {
            opportunityId: opportunity.id,
            objectiveId,
            expectedWorkspaceId: workspaceId,
            ctx: { source: "UI", createdById: context.createdById ?? null },
          })
        } catch (error) {
          if (error instanceof TypedLinkError) throw new OpportunityCreateError("One or more of the selected links are not in this workspace. Nothing was created.")
          throw error
        }
      }

      if (feedbackIds.length > 0) {
        const { count } = await tx.feedbackItem.updateMany({
          where: { id: { in: feedbackIds }, workspaceId },
          data: feedbackOpportunityLinkData(opportunity.id),
        })
        if (count !== feedbackIds.length) {
          throw new OpportunityCreateError("One or more feedback items could not be linked. Nothing was created.")
        }
      }
      return opportunity
    },
    { atomic: true },
  )
}
