import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"

export const TRACKED_SUBJECT_TYPES = ["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK"] as const
export type TrackedSubjectType = (typeof TRACKED_SUBJECT_TYPES)[number]
const TRACKED_GATE = "TRACKED_DECISION"

export class TrackedDecisionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "TrackedDecisionError" }
}

type EntitySummary = { id: string; title: string; workspaceId: string }
type Packet = { schemaVersion: "tracked-decision/v1"; question: string; context: string; entity: { type: TrackedSubjectType; id: string; title: string } }

async function resolveEntity(prisma: ReturnType<typeof getPrisma>, workspaceId: string, type: TrackedSubjectType, id: string): Promise<EntitySummary> {
  let entity: EntitySummary | null = null
  if (type === "WORKSPACE") { const row = await prisma.workspace.findUnique({ where: { id }, select: { id: true, name: true } }); entity = row ? { id: row.id, title: row.name, workspaceId: row.id } : null }
  else if (type === "OPPORTUNITY") entity = await prisma.opportunity.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true } })
  else if (type === "SOLUTION") { const row = await prisma.solution.findUnique({ where: { id }, select: { id: true, title: true, opportunity: { select: { workspaceId: true } } } }); entity = row ? { id: row.id, title: row.title, workspaceId: row.opportunity.workspaceId } : null }
  else if (type === "ROADMAP_ITEM") entity = await prisma.roadmapItem.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true } })
  else if (type === "DOC") entity = await prisma.doc.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true } })
  else if (type === "EXPERIMENT") entity = await prisma.experiment.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true } })
  else entity = await prisma.feedbackItem.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true } })
  if (!entity || entity.workspaceId !== workspaceId) throw new TrackedDecisionError("ENTITY_NOT_FOUND", "Linked item not found or access denied.")
  return entity
}

function required(value: string, label: string, max: number) { const v = value.trim(); if (!v) throw new TrackedDecisionError("INVALID_INPUT", `${label} is required.`); if (v.length > max) throw new TrackedDecisionError("INVALID_INPUT", `${label} must be ${max} characters or fewer.`); return v }
function uuid(value: string, label: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new TrackedDecisionError("INVALID_INPUT", `${label} must be a UUID.`); return value }
function samePacket(raw: string, packet: Packet) { try { const p = JSON.parse(raw) as Packet; return p.question === packet.question && p.context === packet.context && p.entity?.type === packet.entity.type && p.entity?.id === packet.entity.id } catch { return false } }
function isUnique(error: unknown) { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002" }
const options = [
  { actionKey: "APPROVE", label: "Approve", outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 },
  { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 1 },
  { actionKey: "REJECT", label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 2 },
]

export async function createTrackedDecisionRequest(input: { workspaceId: string; subjectType: TrackedSubjectType; subjectId: string; question: string; context: string; idempotencyKey: string; requestedById?: string | null; assignedToId?: string | null }) {
  const question = required(input.question, "Question", 255), context = required(input.context, "Context", 20_000), identity = uuid(input.idempotencyKey, "Idempotency key")
  const prisma = getPrisma(), entity = await resolveEntity(prisma, input.workspaceId, input.subjectType, input.subjectId)
  const packet: Packet = { schemaVersion: "tracked-decision/v1", question, context, entity: { type: input.subjectType, id: entity.id, title: entity.title } }
  const identityWhere = { workspaceId: input.workspaceId, gateType: TRACKED_GATE, subjectType: TRACKED_GATE, subjectId: identity }
  const replay = async () => { const found = await prisma.reviewRequest.findFirst({ where: identityWhere, include: { currentRevision: true } }); if (found?.currentRevision && samePacket(found.currentRevision.packetJson, packet)) return found.currentRevision; throw new TrackedDecisionError("IDEMPOTENCY_KEY_CONFLICT", "That idempotency key belongs to a different decision request.") }
  const existing = await prisma.reviewRequest.findFirst({ where: identityWhere, include: { currentRevision: true } })
  if (existing) return replay()
  try {
    return await prisma.$transaction(async tx => {
      const request = await tx.reviewRequest.create({ data: { ...identityWhere, state: "DRAFT", requestedById: input.requestedById ?? null, assignedToId: input.assignedToId ?? null } })
      const revisionNumber = 1, decisionCycle = 1
      const fingerprint = createHash("sha256").update(JSON.stringify({ requestId: request.id, decisionCycle, revisionNumber, packet })).digest("hex")
      const revision = await tx.reviewRevision.create({ data: { requestId: request.id, revisionNumber, fingerprint, title: question, summary: context, packetJson: JSON.stringify(packet), requiredRole: "ADMIN", options: { create: options } } })
      await tx.reviewRequest.update({ where: { id: request.id }, data: { state: "PENDING", currentRevisionId: revision.id, revisionCount: 1, decisionCycle: 1, updatedAt: new Date() } })
      return revision
    })
  } catch (error) { if (isUnique(error)) return replay(); throw error }
}

export async function reviseTrackedDecisionRequest(input: { workspaceId: string; requestId: string; subjectType: TrackedSubjectType; subjectId: string; question: string; context: string; expectedDecisionId: string; reason: string; requestedById?: string | null; assignedToId?: string | null }) {
  const question = required(input.question, "Question", 255), context = required(input.context, "Context", 20_000), reason = required(input.reason, "Revision reason", 2_000)
  const prisma = getPrisma(), entity = await resolveEntity(prisma, input.workspaceId, input.subjectType, input.subjectId)
  const packet: Packet = { schemaVersion: "tracked-decision/v1", question, context, entity: { type: input.subjectType, id: entity.id, title: entity.title } }
  try {
    return await prisma.$transaction(async tx => {
      const request = await tx.reviewRequest.findUnique({ where: { id: input.requestId } })
      if (!request || request.workspaceId !== input.workspaceId || request.gateType !== TRACKED_GATE) throw new TrackedDecisionError("REQUEST_NOT_FOUND", "The decision to revise was not found.")
      if (request.state !== "DECIDED" || !request.currentRevisionId) throw new TrackedDecisionError("REVISION_CONFLICT", "The decision changed before the revision could be created.")
      const prior = await tx.decisionRecord.findUnique({ where: { id: input.expectedDecisionId } })
      if (!prior || prior.requestId !== request.id || prior.revisionId !== request.currentRevisionId) throw new TrackedDecisionError("DECISION_MISMATCH", "The selected decision does not belong to the current revision.")
      const revisionNumber = request.revisionCount + 1, decisionCycle = request.decisionCycle + 1
      const fingerprint = createHash("sha256").update(JSON.stringify({ requestId: request.id, decisionCycle, revisionNumber, packet })).digest("hex")
      const revision = await tx.reviewRevision.create({ data: { requestId: request.id, revisionNumber, fingerprint, title: question, summary: context, packetJson: JSON.stringify(packet), requiredRole: "ADMIN", options: { create: options } } })
      const claimed = await tx.reviewRequest.updateMany({ where: { id: request.id, state: "DECIDED", currentRevisionId: request.currentRevisionId, decisionCycle: request.decisionCycle }, data: { state: "PENDING", currentRevisionId: revision.id, revisionCount: revisionNumber, decisionCycle, requestedById: input.requestedById ?? request.requestedById, assignedToId: input.assignedToId ?? request.assignedToId, reopenReason: reason, reopenedById: input.requestedById ?? null, reconsidersDecisionId: input.expectedDecisionId, updatedAt: new Date() } })
      if (claimed.count !== 1) throw new TrackedDecisionError("REVISION_CONFLICT", "The decision changed before the revision could be created.")
      await tx.reviewRevision.update({ where: { id: request.currentRevisionId }, data: { supersededAt: new Date() } })
      return revision
    })
  } catch (error) { if (isUnique(error)) throw new TrackedDecisionError("REVISION_CONFLICT", "The decision changed before the revision could be created."); throw error }
}

export type TrackedDecisionListInput = { workspaceId: string; tab?: "PENDING" | "DECIDED"; subjectType?: TrackedSubjectType; outcome?: "APPROVE" | "REQUEST_CHANGES" | "REJECT"; reviewerId?: string; query?: string; from?: Date; to?: Date; page?: number; pageSize?: number; includeLegacy?: boolean }
export async function listTrackedDecisions(input: TrackedDecisionListInput) {
  const prisma = getPrisma(), pageSize = Math.min(50, Math.max(1, input.pageSize ?? 20)), page = Math.max(1, input.page ?? 1), query = input.query?.trim()
  if (input.reviewerId) uuid(input.reviewerId, "Reviewer")
  const decisionWhere = { ...(input.outcome ? { option: { outcomeClass: input.outcome } } : {}), ...(input.reviewerId ? { actorUserId: input.reviewerId } : {}), ...((input.from || input.to) ? { decidedAt: { ...(input.from ? { gte: input.from } : {}), ...(input.to ? { lte: input.to } : {}) } } : {}) }
  const revisionPredicates = [
    ...(query ? [{ OR: [{ title: { contains: query, mode: "insensitive" as const } }, { summary: { contains: query, mode: "insensitive" as const } }] }] : []),
    ...((input.outcome || input.reviewerId || input.from || input.to) ? [{ decisions: { some: decisionWhere } }] : []),
    ...(input.subjectType ? [{ packetJson: { contains: `\"type\":\"${input.subjectType}\"` } }] : []),
  ]
  const where = { workspaceId: input.workspaceId, ...(input.includeLegacy ? {} : { gateType: TRACKED_GATE }), ...(input.tab ? { state: input.tab } : {}), ...(revisionPredicates.length ? { currentRevision: { is: { AND: revisionPredicates } } } : {}) }
  const [requests, total] = await Promise.all([prisma.reviewRequest.findMany({ where, include: { currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } } }, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }), prisma.reviewRequest.count({ where })])
  return { requests, total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) }
}

export async function getTrackedDecision(workspaceId: string, requestId: string) { return getPrisma().reviewRequest.findFirst({ where: { id: requestId, workspaceId, gateType: TRACKED_GATE }, include: { currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: { include: { option: true } } } }, revisions: { orderBy: { revisionNumber: "desc" }, include: { decisions: { include: { option: true } } } } } }) }
