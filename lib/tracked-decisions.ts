import { createHash } from "node:crypto"
import getPrisma from "@/lib/db"

// Re-exported (not redefined) so this stays the single source of truth for
// server code while client components can import the constants alone from
// `./tracked-decision-types` without pulling Prisma/`pg` into their bundle.
export { TRACKED_SUBJECT_TYPES, TRACKED_SUBJECT_LABELS, TRACKED_SOURCE_TYPES, type TrackedSubjectType, type TrackedSourceType } from "./tracked-decision-types"
import { TRACKED_SOURCE_TYPES, type TrackedSubjectType, type TrackedSourceType } from "./tracked-decision-types"
export type TrackedDecisionSourceInput = { type: TrackedSourceType; id: string }
const TRACKED_GATE = "TRACKED_DECISION"

export class TrackedDecisionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "TrackedDecisionError" }
}

export type TrackedDecisionSourceSnapshot = { type: TrackedSourceType; id: string; title: string; updatedAt: string }
type EntitySummary = { id: string; title: string; workspaceId: string; updatedAt: Date }
type PacketV1 = { schemaVersion: "tracked-decision/v1"; question: string; context: string; entity: { type: TrackedSubjectType; id: string; title: string } }
type PacketV2 = { schemaVersion: "tracked-decision/v2"; question: string; context: string; entity: TrackedDecisionSourceSnapshot & { type: TrackedSubjectType }; sources: TrackedDecisionSourceSnapshot[] }
type Packet = PacketV1 | PacketV2

async function resolveEntity(prisma: ReturnType<typeof getPrisma>, workspaceId: string, type: TrackedSourceType, id: string): Promise<EntitySummary> {
  let entity: EntitySummary | null = null
  if (type === "WORKSPACE") { const row = await prisma.workspace.findUnique({ where: { id }, select: { id: true, name: true, updatedAt: true } }); entity = row ? { id: row.id, title: row.name, workspaceId: row.id, updatedAt: row.updatedAt } : null }
  else if (type === "OPPORTUNITY") entity = await prisma.opportunity.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true, updatedAt: true } })
  else if (type === "SOLUTION") { const row = await prisma.solution.findUnique({ where: { id }, select: { id: true, title: true, updatedAt: true, opportunity: { select: { workspaceId: true } } } }); entity = row ? { id: row.id, title: row.title, workspaceId: row.opportunity.workspaceId, updatedAt: row.updatedAt } : null }
  else if (type === "ASSUMPTION") { const row = await prisma.assumption.findUnique({ where: { id }, select: { id: true, title: true, updatedAt: true, solution: { select: { opportunity: { select: { workspaceId: true } } } } } }); entity = row ? { id: row.id, title: row.title, workspaceId: row.solution.opportunity.workspaceId, updatedAt: row.updatedAt } : null }
  else if (type === "ROADMAP_ITEM") entity = await prisma.roadmapItem.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true, updatedAt: true } })
  else if (type === "DOC") entity = await prisma.doc.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true, updatedAt: true } })
  else if (type === "EXPERIMENT") entity = await prisma.experiment.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true, updatedAt: true } })
  else if (type === "FEEDBACK") entity = await prisma.feedbackItem.findUnique({ where: { id }, select: { id: true, title: true, workspaceId: true, updatedAt: true } })
  else { const row = await prisma.evidence.findUnique({ where: { id }, select: { id: true, excerpt: true, workspaceId: true, updatedAt: true } }); entity = row ? { id: row.id, title: row.excerpt.replace(/\s+/g, " ").trim() || "Evidence", workspaceId: row.workspaceId, updatedAt: row.updatedAt } : null }
  if (!entity || entity.workspaceId !== workspaceId) throw new TrackedDecisionError("ENTITY_NOT_FOUND", "Linked item not found or access denied.")
  return entity
}

function required(value: string, label: string, max: number) { const v = value.trim(); if (!v) throw new TrackedDecisionError("INVALID_INPUT", `${label} is required.`); if (v.length > max) throw new TrackedDecisionError("INVALID_INPUT", `${label} must be ${max} characters or fewer.`); return v }
function uuid(value: string, label: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new TrackedDecisionError("INVALID_INPUT", `${label} must be a UUID.`); return value }
function samePacket(raw: string, packet: Packet) {
  try {
    const p = JSON.parse(raw) as Packet
    const coreMatches = p.question === packet.question && p.context === packet.context && p.entity?.type === packet.entity.type && p.entity?.id === packet.entity.id
    if (!coreMatches) return false
    if (p.schemaVersion !== "tracked-decision/v2" || packet.schemaVersion !== "tracked-decision/v2") return p.schemaVersion !== "tracked-decision/v2" && packet.schemaVersion === "tracked-decision/v2" && packet.sources.length === 0
    const identities = (sources: TrackedDecisionSourceSnapshot[]) => [...new Set(sources.map((source) => `${source.type}:${source.id}`))].sort()
    return JSON.stringify(identities(p.sources)) === JSON.stringify(identities(packet.sources))
  } catch { return false }
}
function normalizeSourceInputs(sources: TrackedDecisionSourceInput[] | undefined, primary: TrackedDecisionSourceInput) {
  if ((sources?.length ?? 0) > 12) throw new TrackedDecisionError("INVALID_INPUT", "Sources must contain 12 items or fewer.")
  const valid = new Set<string>(TRACKED_SOURCE_TYPES)
  const unique = new Map<string, TrackedDecisionSourceInput>()
  for (const source of sources ?? []) {
    if (!valid.has(source.type) || !source.id) throw new TrackedDecisionError("INVALID_INPUT", "Each source must have a supported type and an id.")
    if (source.type === primary.type && source.id === primary.id) continue
    unique.set(`${source.type}:${source.id}`, source)
  }
  return [...unique.values()].sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id))
}
async function resolveSources(prisma: ReturnType<typeof getPrisma>, workspaceId: string, inputs: TrackedDecisionSourceInput[]) {
  return Promise.all(inputs.map(async ({ type, id }): Promise<TrackedDecisionSourceSnapshot> => {
    const entity = await resolveEntity(prisma, workspaceId, type, id)
    return { type, id: entity.id, title: entity.title, updatedAt: entity.updatedAt?.toISOString?.() ?? new Date(0).toISOString() }
  }))
}
function isUnique(error: unknown) { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002" }
const options = [
  { actionKey: "APPROVE", label: "Approve", outcomeClass: "APPROVE", continuationKey: "NO_ACTION", sortOrder: 0 },
  { actionKey: "REQUEST_CHANGES", label: "Request changes", outcomeClass: "REQUEST_CHANGES", continuationKey: "NO_ACTION", sortOrder: 1 },
  { actionKey: "REJECT", label: "Reject", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 2 },
]

export async function createTrackedDecisionRequest(input: { workspaceId: string; subjectType: TrackedSubjectType; subjectId: string; question: string; context: string; idempotencyKey: string; sources?: TrackedDecisionSourceInput[]; requestedById?: string | null; assignedToId?: string | null }) {
  const question = required(input.question, "Question", 255), context = required(input.context, "Context", 20_000), identity = uuid(input.idempotencyKey, "Idempotency key")
  const normalizedSourceInputs = normalizeSourceInputs(input.sources, { type: input.subjectType, id: input.subjectId })
  const prisma = getPrisma(), [entity, sources] = await Promise.all([resolveEntity(prisma, input.workspaceId, input.subjectType, input.subjectId), resolveSources(prisma, input.workspaceId, normalizedSourceInputs)])
  const packet: PacketV2 = { schemaVersion: "tracked-decision/v2", question, context, entity: { type: input.subjectType, id: entity.id, title: entity.title, updatedAt: entity.updatedAt?.toISOString?.() ?? new Date(0).toISOString() }, sources }
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
  let packet: Packet
  try {
    return await prisma.$transaction(async tx => {
      const request = await tx.reviewRequest.findUnique({ where: { id: input.requestId }, include: { currentRevision: true } })
      if (!request || request.workspaceId !== input.workspaceId || request.gateType !== TRACKED_GATE) throw new TrackedDecisionError("REQUEST_NOT_FOUND", "The decision to revise was not found.")
      if (request.state !== "DECIDED" || !request.currentRevisionId) throw new TrackedDecisionError("REVISION_CONFLICT", "The decision changed before the revision could be created.")
      if (!request.currentRevision) throw new TrackedDecisionError("REVISION_CONFLICT", "The current decision revision is unavailable.")
      let currentPacket: Packet
      try { currentPacket = JSON.parse(request.currentRevision.packetJson) as Packet } catch { throw new TrackedDecisionError("INVALID_PACKET", "The current decision packet is invalid.") }
      if (currentPacket.entity?.type !== input.subjectType || currentPacket.entity?.id !== entity.id) throw new TrackedDecisionError("ENTITY_MISMATCH", "A revised request must remain linked to the original item.")
      if (currentPacket.schemaVersion === "tracked-decision/v2" && !Array.isArray(currentPacket.sources)) throw new TrackedDecisionError("INVALID_PACKET", "The current decision packet is invalid.")
      packet = currentPacket.schemaVersion === "tracked-decision/v2"
        ? { schemaVersion: "tracked-decision/v2", question, context, entity: { type: input.subjectType, id: entity.id, title: entity.title, updatedAt: entity.updatedAt?.toISOString?.() ?? new Date(0).toISOString() }, sources: currentPacket.sources }
        : { schemaVersion: "tracked-decision/v1", question, context, entity: { type: input.subjectType, id: entity.id, title: entity.title } }
      const prior = await tx.decisionRecord.findUnique({ where: { id: input.expectedDecisionId }, include: { option: true } })
      if (!prior || prior.requestId !== request.id || prior.revisionId !== request.currentRevisionId) throw new TrackedDecisionError("DECISION_MISMATCH", "The selected decision does not belong to the current revision.")
      if (prior.option.outcomeClass !== "REQUEST_CHANGES") throw new TrackedDecisionError("OUTCOME_NOT_REVISABLE", "Only a request-changes decision can be revised.")
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

export type PendingDocDecision = { id: string; title: string }
export type DecidedDocDecision = { id: string; title: string; outcome: string; outcomeLabel: string; decidedAt: Date; reviewerName: string | null }
/**
 * Both halves of a document's decision state. The pending list drives the
 * actionable "Decision pending" control; `latestDecided` exists so an answered
 * question does not silently disappear from the document, which previously
 * made the toolbar fall back to the request-a-decision zero state and invite a
 * duplicate request.
 */
export type DocDecisions = { pending: PendingDocDecision[]; latestDecided: DecidedDocDecision | null }

/**
 * `packetJson: { contains: docId }` is only a coarse prefilter — the id can
 * appear in a source, in prose context, or under a different entity type — so
 * every candidate's packet is parsed and its primary entity checked. Shared by
 * the pending and decided lookups so the two can never disagree about which
 * requests belong to a document.
 */
function packetTargetsDoc(packetJson: string, docId: string): boolean {
  let packet: unknown
  try { packet = JSON.parse(packetJson) } catch { throw new TrackedDecisionError("INVALID_PACKET", "The current decision packet is invalid.") }
  if (!packet || typeof packet !== "object" || !("schemaVersion" in packet)) throw new TrackedDecisionError("INVALID_PACKET", "The current decision packet is invalid.")
  if (packet.schemaVersion !== "tracked-decision/v1" && packet.schemaVersion !== "tracked-decision/v2") return false
  if (!("entity" in packet) || !packet.entity || typeof packet.entity !== "object" || !("type" in packet.entity) || !("id" in packet.entity) || typeof packet.entity.type !== "string" || typeof packet.entity.id !== "string") throw new TrackedDecisionError("INVALID_PACKET", "The current decision subject is invalid.")
  return packet.entity.type === "DOC" && packet.entity.id === docId
}

/**
 * The most recently recorded decision on a document, or null.
 *
 * Queried from `DecisionRecord` rather than `ReviewRequest` so it can use the
 * `[workspaceId, decidedAt]` index and order by when the call was actually
 * made. Deliberately not filtered by the request's current state: a decision
 * that was later reopened for revision was still genuinely made, and the
 * caller gives the live pending list precedence anyway.
 *
 * Call only after authorizing access to the workspace and document.
 */
export async function findLatestDecidedDocDecision(workspaceId: string, docId: string): Promise<DecidedDocDecision | null> {
  const prisma = getPrisma()
  const batchSize = 100
  let skip = 0
  while (true) {
    const candidates = await prisma.decisionRecord.findMany({
      where: { workspaceId, request: { is: { gateType: TRACKED_GATE } }, revision: { is: { packetJson: { contains: docId } } } },
      select: { requestId: true, decidedAt: true, actorUserId: true, option: { select: { outcomeClass: true, label: true } }, revision: { select: { title: true, packetJson: true } } },
      orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
      skip, take: batchSize,
    })
    for (const record of candidates) {
      if (!record.revision) throw new TrackedDecisionError("INVALID_PACKET", "The decided revision is unavailable.")
      if (!packetTargetsDoc(record.revision.packetJson, docId)) continue
      const reviewer = await prisma.user.findUnique({ where: { id: record.actorUserId }, select: { name: true, email: true } })
      return {
        id: record.requestId,
        title: record.revision.title,
        outcome: record.option.outcomeClass,
        outcomeLabel: record.option.label,
        decidedAt: record.decidedAt,
        reviewerName: reviewer?.name ?? reviewer?.email ?? null,
      }
    }
    if (candidates.length < batchSize) return null
    skip += batchSize
  }
}

/** Call only after authorizing access to the workspace and document. */
export async function listDocDecisions(workspaceId: string, docId: string): Promise<DocDecisions> {
  // Sequential, not concurrent: the pending list is what the toolbar shows
  // when it is non-empty, so there is no reason to pay for the decided lookup
  // (and its reviewer read) on a document with an open question.
  const pending = await listPendingDocDecisions(workspaceId, docId)
  if (pending.length > 0) return { pending, latestDecided: null }
  return { pending, latestDecided: await findLatestDecidedDocDecision(workspaceId, docId) }
}

/** Call only after authorizing access to the workspace and document. */
export async function listPendingDocDecisions(workspaceId: string, docId: string): Promise<PendingDocDecision[]> {
  const prisma = getPrisma()
  const decisions: PendingDocDecision[] = []
  const batchSize = 100
  let after: { id: string; updatedAt: Date } | undefined
  while (true) {
    const candidates = await prisma.reviewRequest.findMany({
      where: {
        workspaceId, gateType: TRACKED_GATE, state: "PENDING",
        // subjectId is the idempotency key. Only the current packet identifies
        // the document; missing revisions must not masquerade as an empty list.
        OR: [{ currentRevision: { is: { packetJson: { contains: docId } } } }, { currentRevision: { is: null } }],
        ...(after ? { AND: [{ OR: [{ updatedAt: { lt: after.updatedAt } }, { updatedAt: after.updatedAt, id: { lt: after.id } }] }] } : {}),
      },
      select: { id: true, updatedAt: true, currentRevision: { select: { title: true, packetJson: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: batchSize,
    })
    for (const request of candidates) {
      if (!request.currentRevision) throw new TrackedDecisionError("INVALID_PACKET", "The current decision revision is unavailable.")
      if (packetTargetsDoc(request.currentRevision.packetJson, docId)) decisions.push({ id: request.id, title: request.currentRevision.title })
    }
    if (candidates.length < batchSize) return decisions
    after = candidates[candidates.length - 1]
  }
}

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

/**
 * Applies a decided TRACKED_DECISION (the ordinary workspace Decisions
 * queue created via `createTrackedDecisionRequest`/`request_decision`).
 * Every option on this gate has `continuationKey: "NO_ACTION"` — Compass
 * Decisions are tracking-only here, so "applying" never mutates product
 * state. It only records a durable `DecisionApplication` receipt, exactly
 * mirroring the idempotent create-or-replay pattern in
 * `applyBuildingInvestmentDecision` (lib/building-investment.ts): a stable
 * `receiptKey` makes repeat calls (or a race between two callers) return the
 * same row instead of creating a second one or re-deriving anything.
 */
export async function applyTrackedDecision(decisionId: string) {
  const prisma = getPrisma()
  const receiptKey = `tracked-decision:${decisionId}:v1`
  try {
    return await prisma.$transaction(async (tx) => {
      const replay = await tx.decisionApplication.findUnique({ where: { receiptKey } })
      if (replay) {
        if (replay.decisionId !== decisionId || replay.continuationKey !== "NO_ACTION" || replay.targetType !== "TRACKED_DECISION" || replay.status !== "APPLIED") {
          throw new TrackedDecisionError("RECEIPT_CONFLICT", "The application receipt does not match this decision.")
        }
        return replay
      }
      // A single relation path (decision.revision.request) is the sole
      // source of truth here — unlike applyBuildingInvestmentDecision, there
      // is no separate target entity (e.g. a Solution) to cross-check a
      // second request reference against, since a tracked decision applies
      // to nothing but itself.
      const decision = await tx.decisionRecord.findUnique({
        where: { id: decisionId },
        include: { revision: { include: { request: true, options: { select: { id: true } } } }, option: true },
      })
      const request = decision?.revision.request
      const selectedBelongsToRevision = Boolean(decision?.revision.options.some((option) => option.id === decision.optionId))
      if (!decision || !request
        || request.gateType !== TRACKED_GATE
        || request.state !== "DECIDED" || request.currentRevisionId !== decision.revisionId
        || decision.fingerprint !== decision.revision.fingerprint || decision.revision.supersededAt || !selectedBelongsToRevision
        || decision.option.continuationKey !== "NO_ACTION") {
        throw new TrackedDecisionError("DECISION_MISMATCH", "Decision is not a current tracked (NO_ACTION) decision.")
      }
      return tx.decisionApplication.create({ data: {
        decisionId, continuationKey: "NO_ACTION", targetType: "TRACKED_DECISION", targetId: request.id,
        status: "APPLIED", receiptKey, attemptCount: 1, appliedAt: new Date(), updatedAt: new Date(),
      } })
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await prisma.decisionApplication.findUnique({ where: { receiptKey } })
      if (winner?.decisionId === decisionId && winner.status === "APPLIED" && winner.targetType === "TRACKED_DECISION" && winner.continuationKey === "NO_ACTION") return winner
      throw new TrackedDecisionError("RECEIPT_CONFLICT", "A concurrent application receipt does not match this decision.")
    }
    throw error
  }
}
