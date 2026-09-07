import { createHash } from "node:crypto"
import type { TrackedDecisionSourceSnapshot, TrackedSourceType } from "@/lib/tracked-decisions"

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi
const UUID_EXACT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FINGERPRINT_EXACT = /^[0-9a-f]{64}$/i
const REPAIR_KIND = "legacy-presentation/v1" as const
const CARD_TYPES = new Set<LegacyDecisionRepairReferenceType>(["WORKSPACE", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK", "EVIDENCE"])

export const LEGACY_DECISION_REPAIR_REFERENCE_TYPES = [
  "WORKSPACE", "OPPORTUNITY", "SOLUTION", "ASSUMPTION", "ROADMAP_ITEM", "DOC", "EXPERIMENT", "FEEDBACK", "EVIDENCE", "TASK", "EXPERIMENT_RESULT",
] as const

export type LegacyDecisionRepairReferenceType = (typeof LEGACY_DECISION_REPAIR_REFERENCE_TYPES)[number]
export type LegacyDecisionRepairReference = { type: LegacyDecisionRepairReferenceType; id: string }
export type LegacyDecisionRepairManifest = {
  workspaceId: string
  requests: Array<{
    requestId: string
    expectedRevisionId: string
    expectedFingerprint: string
    references: LegacyDecisionRepairReference[]
  }>
}

type QueryModel = { findFirst(args: unknown): Promise<unknown> }
type WorkspaceModel = { findUnique(args: unknown): Promise<unknown> }
type RepairTransaction = {
  reviewRequest: { findFirst(args: unknown): Promise<unknown>; updateMany(args: unknown): Promise<{ count: number }> }
  reviewRevision: { create(args: unknown): Promise<unknown>; updateMany(args: unknown): Promise<{ count: number }> }
}

export type LegacyDecisionRepairClient = {
  reviewRequest: QueryModel
  workspace: WorkspaceModel
  experiment: QueryModel
  assumption: QueryModel
  solution: QueryModel
  opportunity: QueryModel
  experimentResult: QueryModel
  task: QueryModel
  evidence: QueryModel
  roadmapItem: QueryModel
  doc: QueryModel
  feedbackItem: QueryModel
  $transaction<T>(callback: (tx: RepairTransaction) => Promise<T>): Promise<T>
}

type LegacyPacket = {
  schemaVersion: "tracked-decision/v1"
  question: string
  context: string
  entity: { type: TrackedSourceType; id: string; title: string }
}

export type RepairedLegacyPacket = {
  schemaVersion: "tracked-decision/v2"
  question: string
  context: string
  entity: TrackedDecisionSourceSnapshot
  sources: TrackedDecisionSourceSnapshot[]
  repair: {
    kind: typeof REPAIR_KIND
    sourceRevisionId: string
    sourceFingerprint: string
    titleBasis: "current-at-repair"
    audit?: { sourceVersion?: string; sourceFingerprint?: string }
  }
}

type ReviewOption = { actionKey: string; label: string; outcomeClass: string; continuationKey: string; sortOrder: number }
type CurrentRevision = {
  id: string
  revisionNumber: number
  fingerprint: string
  sourceFingerprint: string | null
  title: string
  summary: string | null
  packetJson: string
  requiredRole: string
  expiresAt: Date | null
  supersededAt: Date | null
  options: ReviewOption[]
  decisions: unknown[]
}
type RepairRequest = {
  id: string
  workspaceId: string
  gateType: string
  state: string
  currentRevisionId: string | null
  revisionCount: number
  decisionCycle: number
  currentRevision: CurrentRevision | null
  decisions: unknown[]
  workspace: { id: string; slug: string; organization: { slug: string } }
}

export type LegacyDecisionRepairPlan = {
  requestId: string
  status: "READY" | "APPLIED" | "SKIPPED_DECIDED" | "ALREADY_APPLIED" | "NOT_ELIGIBLE" | "ERROR"
  code?: string
  message: string
  sourceRevisionId?: string
  newRevisionNumber?: number
  fingerprint?: string
  packet?: RepairedLegacyPacket
  summary?: string
}

class LegacyDecisionRepairError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "LegacyDecisionRepairError"
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !UUID_EXACT.test(value)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `${label} must be a UUID.`)
}

export function parseLegacyDecisionRepairManifest(value: unknown): LegacyDecisionRepairManifest {
  if (!isRecord(value)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", "Manifest must be a JSON object.")
  assertUuid(value.workspaceId, "workspaceId")
  if (!Array.isArray(value.requests) || value.requests.length === 0) throw new LegacyDecisionRepairError("INVALID_MANIFEST", "requests must be a non-empty allowlist.")
  const requestIds = new Set<string>()
  const requests = value.requests.map((item, requestIndex) => {
    if (!isRecord(item)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `requests[${requestIndex}] must be an object.`)
    assertUuid(item.requestId, `requests[${requestIndex}].requestId`)
    assertUuid(item.expectedRevisionId, `requests[${requestIndex}].expectedRevisionId`)
    if (typeof item.expectedFingerprint !== "string" || !FINGERPRINT_EXACT.test(item.expectedFingerprint)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `requests[${requestIndex}].expectedFingerprint must be a SHA-256 fingerprint.`)
    if (requestIds.has(item.requestId)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `Duplicate requestId ${item.requestId}.`)
    requestIds.add(item.requestId)
    if (!Array.isArray(item.references)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `requests[${requestIndex}].references must be an array.`)
    const identities = new Set<string>()
    const references = item.references.map((reference, referenceIndex) => {
      if (!isRecord(reference) || !LEGACY_DECISION_REPAIR_REFERENCE_TYPES.includes(reference.type as LegacyDecisionRepairReferenceType)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `requests[${requestIndex}].references[${referenceIndex}] has an unsupported type.`)
      assertUuid(reference.id, `requests[${requestIndex}].references[${referenceIndex}].id`)
      const identity = `${reference.type}:${reference.id}`
      if (identities.has(identity)) throw new LegacyDecisionRepairError("INVALID_MANIFEST", `Duplicate reference ${identity}.`)
      identities.add(identity)
      return { type: reference.type as LegacyDecisionRepairReferenceType, id: reference.id }
    })
    return { requestId: item.requestId, expectedRevisionId: item.expectedRevisionId, expectedFingerprint: item.expectedFingerprint, references }
  })
  return { workspaceId: value.workspaceId, requests }
}

function parseLegacyPacket(raw: string): LegacyPacket {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new LegacyDecisionRepairError("INVALID_PACKET", "The current revision packet is not valid JSON.") }
  if (!isRecord(value) || value.schemaVersion !== "tracked-decision/v1" || typeof value.question !== "string" || typeof value.context !== "string" || !isRecord(value.entity)) {
    throw new LegacyDecisionRepairError("NOT_V1", "Only tracked-decision/v1 packets are eligible.")
  }
  const entity = value.entity
  if (!LEGACY_DECISION_REPAIR_REFERENCE_TYPES.includes(entity.type as LegacyDecisionRepairReferenceType) || !CARD_TYPES.has(entity.type as LegacyDecisionRepairReferenceType) || typeof entity.title !== "string") {
    throw new LegacyDecisionRepairError("INVALID_PACKET", "The v1 primary entity is invalid.")
  }
  assertUuid(entity.id, "packet.entity.id")
  return { schemaVersion: "tracked-decision/v1", question: value.question, context: value.context, entity: { type: entity.type as TrackedSourceType, id: entity.id, title: entity.title } }
}

function repairedFromExpected(request: RepairRequest, expectedRevisionId: string, expectedFingerprint: string) {
  if (!request.currentRevision) return false
  try {
    const packet = JSON.parse(request.currentRevision.packetJson) as { repair?: { kind?: string; sourceRevisionId?: string; sourceFingerprint?: string } }
    return packet.repair?.kind === REPAIR_KIND && packet.repair.sourceRevisionId === expectedRevisionId && packet.repair.sourceFingerprint === expectedFingerprint
  } catch { return false }
}

function asRequest(value: unknown): RepairRequest {
  if (!isRecord(value) || typeof value.id !== "string" || !isRecord(value.workspace) || !isRecord(value.currentRevision)) {
    throw new LegacyDecisionRepairError("REQUEST_NOT_FOUND", "The allowlisted review request was not found in the workspace.")
  }
  return value as unknown as RepairRequest
}

type ResolvedReference = {
  type: LegacyDecisionRepairReferenceType
  id: string
  title: string
  updatedAt: Date
  linkType: LegacyDecisionRepairReferenceType
  linkId: string
}

function cleanTitle(value: string, fallback: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 255) || fallback
}

function row(value: unknown, code = "REFERENCE_NOT_FOUND") {
  if (!isRecord(value)) throw new LegacyDecisionRepairError(code, "A typed reference was not found in the allowlisted workspace.")
  return value
}

async function resolveReference(db: LegacyDecisionRepairClient, workspaceId: string, reference: LegacyDecisionRepairReference): Promise<ResolvedReference> {
  const base = { type: reference.type, id: reference.id }
  if (reference.type === "WORKSPACE") {
    const found = row(await db.workspace.findUnique({ where: { id: reference.id }, select: { id: true, name: true, updatedAt: true } }))
    if (found.id !== workspaceId) throw new LegacyDecisionRepairError("REFERENCE_NOT_FOUND", "A typed reference was not found in the allowlisted workspace.")
    return { ...base, title: cleanTitle(String(found.name), "Workspace"), updatedAt: found.updatedAt as Date, linkType: "WORKSPACE", linkId: reference.id }
  }
  if (reference.type === "OPPORTUNITY") {
    const found = row(await db.opportunity.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Opportunity"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "SOLUTION") {
    const found = row(await db.solution.findFirst({ where: { id: reference.id, opportunity: { workspaceId } }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Solution"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "ASSUMPTION") {
    const found = row(await db.assumption.findFirst({ where: { id: reference.id, solution: { opportunity: { workspaceId } } }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Assumption"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "ROADMAP_ITEM") {
    const found = row(await db.roadmapItem.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Roadmap item"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "DOC") {
    const found = row(await db.doc.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Document"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "EXPERIMENT") {
    const found = row(await db.experiment.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Experiment"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "FEEDBACK") {
    const found = row(await db.feedbackItem.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Feedback"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "TASK") {
    const found = row(await db.task.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, title: true, updatedAt: true } }))
    return { ...base, title: cleanTitle(String(found.title), "Task"), updatedAt: found.updatedAt as Date, linkType: reference.type, linkId: reference.id }
  }
  if (reference.type === "EXPERIMENT_RESULT") {
    const found = row(await db.experimentResult.findFirst({ where: { id: reference.id, experiment: { workspaceId } }, select: { id: true, note: true, createdAt: true, experiment: { select: { id: true } } } }))
    const experiment = row(found.experiment)
    return { ...base, title: `Result: ${cleanTitle(String(found.note), "Experiment result")}`, updatedAt: found.createdAt as Date, linkType: "EXPERIMENT", linkId: String(experiment.id) }
  }
  const found = row(await db.evidence.findFirst({ where: { id: reference.id, workspaceId }, select: { id: true, excerpt: true, updatedAt: true, opportunityId: true, solutionId: true, assumptionId: true } }))
  const linkType = found.assumptionId ? "ASSUMPTION" : found.solutionId ? "SOLUTION" : found.opportunityId ? "OPPORTUNITY" : "WORKSPACE"
  const linkId = String(found.assumptionId ?? found.solutionId ?? found.opportunityId ?? workspaceId)
  return { ...base, title: cleanTitle(String(found.excerpt), "Evidence"), updatedAt: found.updatedAt as Date, linkType, linkId }
}

function escapeMarkdownLabel(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]{}()#+.!|~-])/g, "\\$1")
}

function referenceUrl(reference: ResolvedReference, orgSlug: string, workspaceSlug: string) {
  const root = `/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}`
  if (reference.linkType === "WORKSPACE") return root
  if (reference.linkType === "DOC") return `${root}/docs/${reference.linkId}`
  if (reference.linkType === "TASK") return `${root}/tasks/${reference.linkId}`
  if (reference.linkType === "EXPERIMENT_RESULT") throw new LegacyDecisionRepairError("INVALID_REFERENCE", "Experiment results must link through their experiment.")
  const panelType: Record<string, string> = { OPPORTUNITY: "opportunity", SOLUTION: "solution", ASSUMPTION: "assumption", ROADMAP_ITEM: "roadmapItem", EXPERIMENT: "experiment", FEEDBACK: "feedback" }
  const type = panelType[reference.linkType]
  if (!type) return root
  return `${root}?detail=${encodeURIComponent(`${type}:${reference.linkId}`)}`
}

function referenceLabel(type: LegacyDecisionRepairReferenceType) {
  if (type === "ROADMAP_ITEM") return "Roadmap item"
  if (type === "EXPERIMENT_RESULT") return "Experiment result"
  return type.charAt(0) + type.slice(1).toLowerCase()
}

function linkedReference(reference: ResolvedReference, orgSlug: string, workspaceSlug: string) {
  return `[${escapeMarkdownLabel(reference.title)}](${referenceUrl(reference, orgSlug, workspaceSlug)})`
}

function replaceReferences(context: string, references: ResolvedReference[], orgSlug: string, workspaceSlug: string) {
  const mappedIds = new Set(references.map((reference) => reference.id.toLowerCase()))
  const mentionedIds = [...context.matchAll(UUID_PATTERN)].map((match) => match[0].toLowerCase())
  const unmapped = mentionedIds.find((id) => !mappedIds.has(id))
  if (unmapped) throw new LegacyDecisionRepairError("UNMAPPED_UUID", `Context contains UUID ${unmapped} without an explicit typed reference.`)
  const byId = new Map(references.map((reference) => [reference.id.toLowerCase(), reference]))
  const hadSourceIds = context.includes("Source IDs:")
  const hadOpportunityList = context.includes("ACTIVE Opportunity IDs:")
  const hadRoadmapList = context.includes("Current NEXT IDs in order:")
  if (!hadSourceIds && !hadOpportunityList && !hadRoadmapList) throw new LegacyDecisionRepairError("UNKNOWN_CONTEXT_PATTERN", "The legacy context does not match a supported repair pattern.")

  const audit: { sourceVersion?: string; sourceFingerprint?: string } = {}
  let formatted = context
  if (hadSourceIds) {
    const sourceBlock = /Source IDs:\s*([\s\S]*?)\.\s*Source version:\s*([\s\S]*?)\.(?=\s+(?:Every outcome|Outcomes\b|This request\b|$))/i
    const match = formatted.match(sourceBlock)
    if (!match) throw new LegacyDecisionRepairError("UNKNOWN_CONTEXT_PATTERN", "The Source IDs block does not match the supported historical format.")
    const orderedIds = [...match[1].matchAll(UUID_PATTERN)].map((item) => item[0].toLowerCase())
    if (orderedIds.length === 0) throw new LegacyDecisionRepairError("UNKNOWN_CONTEXT_PATTERN", "The Source IDs block is empty.")
    const bullets = orderedIds.map((id) => {
      const reference = byId.get(id)
      if (!reference) throw new LegacyDecisionRepairError("UNMAPPED_UUID", `Source IDs contains ${id} without an explicit typed reference.`)
      return `- ${referenceLabel(reference.type)}: ${linkedReference(reference, orgSlug, workspaceSlug)}`
    })
    audit.sourceVersion = match[2].trim()
    formatted = formatted.replace(sourceBlock, `\n\n## Sources\n\n${bullets.join("\n")}\n\n_Source-version metadata is preserved in this repair packet and the prior revision._\n\n`)
  } else {
    const header = hadOpportunityList ? "ACTIVE Opportunity IDs" : "Current NEXT IDs in order"
    const readableHeader = hadOpportunityList ? "ACTIVE Opportunities (original order)" : "Current NEXT queue (original order)"
    const listBlock = new RegExp(`${header}:\\n((?:${UUID_PATTERN.source}(?:\\n|$))+)`, "i")
    const match = formatted.match(listBlock)
    if (!match) throw new LegacyDecisionRepairError("UNKNOWN_CONTEXT_PATTERN", `The ${header} block does not match the supported historical format.`)
    const orderedIds = [...match[1].matchAll(UUID_PATTERN)].map((item) => item[0].toLowerCase())
    const orderedLinks = orderedIds.map((id, index) => {
      const reference = byId.get(id)
      if (!reference) throw new LegacyDecisionRepairError("UNMAPPED_UUID", `${header} contains ${id} without an explicit typed reference.`)
      return `${index + 1}. ${linkedReference(reference, orgSlug, workspaceSlug)}`
    })
    formatted = formatted.replace(listBlock, `\n\n## ${readableHeader}\n\n${orderedLinks.join("\n")}\n\n`)
    const fingerprintPattern = /(?:Source fingerprint|Fingerprint):\s*((?:sha256:)?[a-f0-9]{64})\./i
    const fingerprintMatch = formatted.match(fingerprintPattern)
    if (!fingerprintMatch) throw new LegacyDecisionRepairError("UNKNOWN_CONTEXT_PATTERN", "The list context is missing its historical source fingerprint.")
    audit.sourceFingerprint = fingerprintMatch[1]
    formatted = formatted.replace(fingerprintPattern, "\n\n_Source fingerprint metadata is preserved in this repair packet and the prior revision._\n\n")
  }

  const destinations: string[] = []
  const protectedContext = formatted.replace(/\]\([^)]+\)/g, (destination) => {
    const token = `@@LEGACY_REPAIR_LINK_${destinations.length}@@`
    destinations.push(destination)
    return token
  })
  const linked = protectedContext.replace(UUID_PATTERN, (id) => {
    const reference = byId.get(id.toLowerCase())
    if (!reference) return id
    return linkedReference(reference, orgSlug, workspaceSlug)
  }).replace(/@@LEGACY_REPAIR_LINK_(\d+)@@/g, (_token, index) => destinations[Number(index)])
  return {
    context: `${linked}\n\n---\n\n_Link titles and destinations were resolved during presentation repair from current workspace objects. Original source metadata is preserved in the prior revision._`,
    audit,
  }
}

async function readRequest(db: LegacyDecisionRepairClient, workspaceId: string, requestId: string) {
  return asRequest(await db.reviewRequest.findFirst({
    where: { id: requestId, workspaceId },
    include: {
      currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: true } },
      decisions: true,
      workspace: { select: { id: true, slug: true, organization: { select: { slug: true } } } },
    },
  }))
}

function errorPlan(requestId: string, error: unknown): LegacyDecisionRepairPlan {
  if (error instanceof LegacyDecisionRepairError) return { requestId, status: "ERROR", code: error.code, message: error.message }
  throw error
}

export async function buildLegacyDecisionRepairPlan(db: LegacyDecisionRepairClient, entry: LegacyDecisionRepairManifest["requests"][number], workspaceId: string): Promise<LegacyDecisionRepairPlan> {
  try {
    const request = await readRequest(db, workspaceId, entry.requestId)
    if (request.state === "DECIDED" || request.decisions.length > 0 || (request.currentRevision?.decisions.length ?? 0) > 0) return { requestId: entry.requestId, status: "SKIPPED_DECIDED", message: "A human decision exists; this request is intentionally untouched." }
    if (repairedFromExpected(request, entry.expectedRevisionId, entry.expectedFingerprint)) return { requestId: entry.requestId, status: "ALREADY_APPLIED", message: "The allowlisted legacy revision already has its presentation repair." }
    if (request.gateType !== "TRACKED_DECISION" || request.state !== "PENDING") return { requestId: entry.requestId, status: "NOT_ELIGIBLE", message: "Only pending tracked decisions are eligible." }
    const revision = request.currentRevision
    if (!revision || request.currentRevisionId !== entry.expectedRevisionId || revision.id !== entry.expectedRevisionId || revision.fingerprint !== entry.expectedFingerprint) {
      throw new LegacyDecisionRepairError("EXPECTED_REVISION_MISMATCH", "The current revision or fingerprint differs from the allowlist.")
    }
    if (revision.supersededAt) throw new LegacyDecisionRepairError("REVISION_SUPERSEDED", "The expected current revision is already superseded.")
    const legacyPacket = parseLegacyPacket(revision.packetJson)
    const primary = await resolveReference(db, workspaceId, { type: legacyPacket.entity.type, id: legacyPacket.entity.id })
    const resolved = await Promise.all(entry.references.map((reference) => resolveReference(db, workspaceId, reference)))
    const repaired = replaceReferences(legacyPacket.context, resolved, request.workspace.organization.slug, request.workspace.slug)
    const cardSources = resolved
      .filter((reference) => CARD_TYPES.has(reference.type) && !(reference.type === primary.type && reference.id === primary.id))
      .slice(0, 12)
      .map((reference) => ({ type: reference.type as TrackedSourceType, id: reference.id, title: reference.title, updatedAt: reference.updatedAt.toISOString() }))
    const packet: RepairedLegacyPacket = {
      schemaVersion: "tracked-decision/v2",
      question: legacyPacket.question,
      context: repaired.context,
      entity: { type: primary.type as TrackedSourceType, id: primary.id, title: primary.title, updatedAt: primary.updatedAt.toISOString() },
      sources: cardSources,
      repair: { kind: REPAIR_KIND, sourceRevisionId: revision.id, sourceFingerprint: revision.fingerprint, titleBasis: "current-at-repair", audit: repaired.audit },
    }
    const newRevisionNumber = request.revisionCount + 1
    const fingerprint = createHash("sha256").update(JSON.stringify({ kind: REPAIR_KIND, requestId: request.id, revisionNumber: newRevisionNumber, decisionCycle: request.decisionCycle, packet })).digest("hex")
    return { requestId: request.id, status: "READY", message: "Eligible presentation repair; no data has been changed.", sourceRevisionId: revision.id, newRevisionNumber, fingerprint, packet, summary: repaired.context }
  } catch (error) {
    return errorPlan(entry.requestId, error)
  }
}

async function applyPlan(db: LegacyDecisionRepairClient, manifest: LegacyDecisionRepairManifest, entry: LegacyDecisionRepairManifest["requests"][number], plan: LegacyDecisionRepairPlan) {
  if (plan.status !== "READY" || !plan.packet || !plan.fingerprint || !plan.newRevisionNumber || !plan.sourceRevisionId || !plan.summary) return plan
  try {
    return await db.$transaction(async (tx) => {
      const request = asRequest(await tx.reviewRequest.findFirst({
        where: { id: entry.requestId, workspaceId: manifest.workspaceId },
        include: { currentRevision: { include: { options: { orderBy: { sortOrder: "asc" } }, decisions: true } }, decisions: true, workspace: { select: { id: true, slug: true, organization: { select: { slug: true } } } } },
      }))
      if (request.state === "DECIDED" || request.decisions.length > 0 || (request.currentRevision?.decisions.length ?? 0) > 0) return { requestId: entry.requestId, status: "SKIPPED_DECIDED" as const, message: "A human decision exists; this request is intentionally untouched." }
      if (repairedFromExpected(request, entry.expectedRevisionId, entry.expectedFingerprint)) return { requestId: entry.requestId, status: "ALREADY_APPLIED" as const, message: "The allowlisted legacy revision already has its presentation repair." }
      const revision = request.currentRevision
      if (request.gateType !== "TRACKED_DECISION" || request.state !== "PENDING" || request.currentRevisionId !== entry.expectedRevisionId || revision?.id !== entry.expectedRevisionId || revision.fingerprint !== entry.expectedFingerprint || revision.supersededAt) {
        throw new LegacyDecisionRepairError("CAS_CONFLICT", "The request changed after dry-run planning; transaction rolled back.")
      }
      parseLegacyPacket(revision.packetJson)
      const created = await tx.reviewRevision.create({ data: {
        requestId: request.id,
        revisionNumber: plan.newRevisionNumber,
        sourceFingerprint: revision.sourceFingerprint,
        fingerprint: plan.fingerprint,
        title: revision.title,
        summary: plan.summary,
        packetJson: JSON.stringify(plan.packet),
        requiredRole: revision.requiredRole,
        expiresAt: revision.expiresAt,
        options: { create: revision.options.map(({ actionKey, label, outcomeClass, continuationKey, sortOrder }) => ({ actionKey, label, outcomeClass, continuationKey, sortOrder })) },
      } }) as { id?: string }
      if (!created.id) throw new LegacyDecisionRepairError("CREATE_FAILED", "The replacement revision was not created.")
      const claimed = await tx.reviewRequest.updateMany({
        where: {
          id: request.id,
          workspaceId: manifest.workspaceId,
          gateType: "TRACKED_DECISION",
          state: "PENDING",
          currentRevisionId: entry.expectedRevisionId,
          revisionCount: request.revisionCount,
          decisionCycle: request.decisionCycle,
          currentRevision: { is: { fingerprint: entry.expectedFingerprint, decisions: { none: {} } } },
          decisions: { none: {} },
        },
        data: { currentRevisionId: created.id, revisionCount: plan.newRevisionNumber, decisionCycle: request.decisionCycle, updatedAt: new Date() },
      })
      if (claimed.count !== 1) throw new LegacyDecisionRepairError("CAS_CONFLICT", "The request changed while the presentation repair was being applied; transaction rolled back.")
      const superseded = await tx.reviewRevision.updateMany({ where: { id: revision.id, requestId: request.id, fingerprint: entry.expectedFingerprint, supersededAt: null, decisions: { none: {} } }, data: { supersededAt: new Date() } })
      if (superseded.count !== 1) throw new LegacyDecisionRepairError("CAS_CONFLICT", "The original revision changed while the presentation repair was being applied; transaction rolled back.")
      return { ...plan, status: "APPLIED" as const, message: "A readable revision was appended; the original revision remains in history." }
    })
  } catch (error) {
    return errorPlan(entry.requestId, error)
  }
}

export async function repairLegacyDecisionRequests(db: LegacyDecisionRepairClient, input: LegacyDecisionRepairManifest, options: { apply?: boolean } = {}) {
  const manifest = parseLegacyDecisionRepairManifest(input)
  const mode = options.apply === true ? "APPLY" as const : "DRY_RUN" as const
  const requests: LegacyDecisionRepairPlan[] = []
  for (const entry of manifest.requests) {
    const plan = await buildLegacyDecisionRepairPlan(db, entry, manifest.workspaceId)
    requests.push(mode === "APPLY" ? await applyPlan(db, manifest, entry, plan) : plan)
  }
  return { mode, workspaceId: manifest.workspaceId, requests }
}
