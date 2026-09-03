import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"

export const TRACKED_SUBJECT_TYPES = ["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK"] as const
export type TrackedSubjectType = (typeof TRACKED_SUBJECT_TYPES)[number]

export class TrackedDecisionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "TrackedDecisionError"
  }
}

type EntitySummary = { id: string; title: string; workspaceId: string }

async function resolveEntity(prisma: ReturnType<typeof getPrisma>, workspaceId: string, subjectType: TrackedSubjectType, subjectId: string): Promise<EntitySummary> {
  let entity: EntitySummary | null = null
  if (subjectType === "WORKSPACE") {
    const row = await prisma.workspace.findUnique({ where: { id: subjectId }, select: { id: true, name: true } })
    entity = row ? { id: row.id, title: row.name, workspaceId: row.id } : null
  } else if (subjectType === "OPPORTUNITY") {
    const row = await prisma.opportunity.findUnique({ where: { id: subjectId }, select: { id: true, title: true, workspaceId: true } })
    entity = row
  } else if (subjectType === "SOLUTION") {
    const row = await prisma.solution.findUnique({ where: { id: subjectId }, select: { id: true, title: true, opportunity: { select: { workspaceId: true } } } })
    entity = row ? { id: row.id, title: row.title, workspaceId: row.opportunity.workspaceId } : null
  } else if (subjectType === "ROADMAP_ITEM") {
    entity = await prisma.roadmapItem.findUnique({ where: { id: subjectId }, select: { id: true, title: true, workspaceId: true } })
  } else if (subjectType === "DOC") {
    entity = await prisma.doc.findUnique({ where: { id: subjectId }, select: { id: true, title: true, workspaceId: true } })
  } else if (subjectType === "EXPERIMENT") {
    entity = await prisma.experiment.findUnique({ where: { id: subjectId }, select: { id: true, title: true, workspaceId: true } })
  } else if (subjectType === "FEEDBACK") {
    entity = await prisma.feedbackItem.findUnique({ where: { id: subjectId }, select: { id: true, title: true, workspaceId: true } })
  }
  if (!entity || entity.workspaceId !== workspaceId) {
    throw new TrackedDecisionError("ENTITY_NOT_FOUND", "Linked item not found or access denied.")
  }
  return entity
}

function cleanRequired(value: string, label: string, max: number): string {
  const cleaned = value.trim()
  if (!cleaned) throw new TrackedDecisionError("INVALID_INPUT", `${label} is required.`)
  if (cleaned.length > max) throw new TrackedDecisionError("INVALID_INPUT", `${label} must be ${max} characters or fewer.`)
  return cleaned
}

export async function createTrackedDecisionRequest(input: {
  workspaceId: string
  subjectType: TrackedSubjectType
  subjectId: string
  question: string
  context: string
  requestedById?: string | null
  assignedToId?: string | null
  revise?: { expectedDecisionId: string; reason: string }
}) {
  const question = cleanRequired(input.question, "Question", 255)
  const context = cleanRequired(input.context, "Context", 20_000)
  const prisma = getPrisma()
  const entity = await resolveEntity(prisma, input.workspaceId, input.subjectType, input.subjectId)
  const packet = {
    schemaVersion: "tracked-decision/v1",
    question,
    context,
    entity: { type: input.subjectType, id: entity.id, title: entity.title },
  }

  return prisma.$transaction(async (tx) => {
    const existing = await tx.reviewRequest.findFirst({
      where: { workspaceId: input.workspaceId, gateType: "TRACKED_DECISION", subjectType: input.subjectType, subjectId: input.subjectId },
      include: { currentRevision: true },
    })
    if (existing?.state === "PENDING") {
      if (existing.currentRevision) {
        const current = JSON.parse(existing.currentRevision.packetJson) as typeof packet
        if (current.question === question && current.context === context && current.entity?.type === input.subjectType && current.entity?.id === entity.id) {
          return existing.currentRevision
        }
      }
      throw new TrackedDecisionError("DECISION_PENDING", "This item already has a pending decision.")
    }
    if (existing && !input.revise) {
      throw new TrackedDecisionError("REVISION_REQUIRED", "Create a revised request from the previous decision.")
    }
    if (!existing && input.revise) {
      throw new TrackedDecisionError("REQUEST_NOT_FOUND", "The decision to revise was not found.")
    }

    let decisionCycle = existing?.decisionCycle ?? 1
    if (existing && input.revise) {
      const prior = await tx.decisionRecord.findUnique({ where: { id: input.revise.expectedDecisionId } })
      if (!prior || prior.requestId !== existing.id || prior.revisionId !== existing.currentRevisionId) {
        throw new TrackedDecisionError("DECISION_MISMATCH", "The selected decision does not belong to this request.")
      }
      if (!input.revise.reason.trim()) throw new TrackedDecisionError("INVALID_INPUT", "Revision reason is required.")
      if (existing.currentRevisionId) await tx.reviewRevision.update({ where: { id: existing.currentRevisionId }, data: { supersededAt: new Date() } })
      decisionCycle += 1
    }

    const request = existing ?? await tx.reviewRequest.create({ data: {
      workspaceId: input.workspaceId, gateType: "TRACKED_DECISION", subjectType: input.subjectType,
      subjectId: input.subjectId, state: "DRAFT", requestedById: input.requestedById ?? null,
      assignedToId: input.assignedToId ?? null,
    } })
    const revisionNumber = request.revisionCount + 1
    const fingerprint = createHash("sha256").update(JSON.stringify({ requestId: request.id, decisionCycle, revisionNumber, packet })).digest("hex")
    const revision = await tx.reviewRevision.create({ data: {
      requestId: request.id, revisionNumber, fingerprint, title: question, summary: context,
      packetJson: JSON.stringify(packet), requiredRole: "ADMIN",
      options: { create: [
        { actionKey: "APPROVE", label: "Approve", outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 },
        { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 1 },
        { actionKey: "REJECT", label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 2 },
      ] },
    } })
    await tx.reviewRequest.update({ where: { id: request.id }, data: {
      state: "PENDING", currentRevisionId: revision.id, revisionCount: revisionNumber, decisionCycle,
      requestedById: input.requestedById ?? request.requestedById ?? null,
      assignedToId: input.assignedToId ?? request.assignedToId ?? null,
      reopenReason: input.revise?.reason.trim() ?? null,
      reopenedById: input.revise ? input.requestedById ?? null : null,
      reconsidersDecisionId: input.revise?.expectedDecisionId ?? null,
      updatedAt: new Date(),
    } })
    return revision
  })
}

export type TrackedDecisionListInput = {
  workspaceId: string
  tab?: "PENDING" | "DECIDED"
  subjectType?: TrackedSubjectType
  outcome?: "APPROVE" | "REQUEST_CHANGES" | "REJECT"
  reviewerId?: string
  query?: string
  from?: Date
  to?: Date
  page?: number
  pageSize?: number
}

export async function listTrackedDecisions(input: TrackedDecisionListInput) {
  const prisma = getPrisma()
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 20))
  const page = Math.max(1, input.page ?? 1)
  const query = input.query?.trim()
  const where = {
    workspaceId: input.workspaceId,
    ...(input.tab ? { state: input.tab } : {}),
    ...(input.subjectType ? { subjectType: input.subjectType } : {}),
    ...(query ? { currentRevision: { is: { OR: [{ title: { contains: query, mode: "insensitive" as const } }, { summary: { contains: query, mode: "insensitive" as const } }] } } } : {}),
    ...((input.outcome || input.reviewerId || input.from || input.to) ? { decisions: { some: {
      ...(input.outcome ? { option: { outcomeClass: input.outcome } } : {}),
      ...(input.reviewerId ? { actorUserId: input.reviewerId } : {}),
      ...((input.from || input.to) ? { decidedAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}),
    } } } : {}),
  }
  const [requests, total] = await Promise.all([
    prisma.reviewRequest.findMany({
      where,
      include: {
        currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } },
      },
      orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
    }),
    prisma.reviewRequest.count({ where }),
  ])
  return { requests, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function getTrackedDecision(workspaceId: string, requestId: string) {
  return getPrisma().reviewRequest.findFirst({
    where: { id: requestId, workspaceId },
    include: {
      currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } },
      revisions: { orderBy: { revisionNumber: "desc" }, include: { decisions: { include: { option: true } } } },
    },
  })
}
