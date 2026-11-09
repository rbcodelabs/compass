import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { isWorkspaceAdminUser } from "@/lib/agent-ownership"
import { allocateOneSeq, withSequenceTransaction } from "@/lib/work-item-sequence"
import { displayIdFromRow } from "@/lib/work-item-ids"
import { ToolApprovalError } from "@/lib/tool-approval/errors"
import { sanitizeText } from "@/lib/tool-approval/sanitize"
import { EXECUTE_TOOL_APPROVAL_CONTINUATION, TOOL_APPROVAL_GATE, toolApprovalPath } from "@/lib/tool-approval/gate"
import {
  EFFECT_PACKET_SCHEMA_VERSION, argsHashOf, deterministicSubjectId, fingerprintOf, parseEffectPacket, sameJson, toJsonValue,
  type EffectPacket, type Json,
} from "@/lib/tool-approval/packet"
import { getToolApprovalSpec, type ToolApprovalContext } from "@/lib/tool-approval/registry"

/** Pending approvals per workspace. Stops an agent flooding the approvers' queue. */
export const MAX_PENDING_TOOL_APPROVALS = 25
/** How long a request can wait for a human. The post-decision execution window is separate (executor.ts). */
/** Pending approvals one requester (an agent, else a user, else the service key) may hold. */
export const MAX_PENDING_PER_REQUESTER = 5
export const TOOL_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

const GENERATION_BATCH = 16
const MAX_GENERATIONS = 2048
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const approvalOptions = [
  { actionKey: "APPROVE", label: "Approve", outcomeClass: "APPROVE", continuationKey: EXECUTE_TOOL_APPROVAL_CONTINUATION, sortOrder: 0 },
  { actionKey: "REJECT", label: "Deny", outcomeClass: "REJECT", continuationKey: "NO_ACTION", sortOrder: 1 },
]

export type Requester = { userId: string | null; agentId: string | null }

export type PendingApproval = {
  status: "APPROVAL_REQUIRED"
  requestId: string
  revisionId: string
  displayId: string | null
  /** Workspace-relative path of the dedicated approval page (built in A3). */
  path: string
  title: string
  summary: string
  before: Json
  after: Json
  expiresAt: Date | null
  /** True when an identical call was already waiting and no new request was created. */
  reused: boolean
}

export type RequestToolApprovalOutcome = { status: "NOT_REGISTERED" } | { status: "BLOCKED"; floors: string[] } | PendingApproval

/** Pending and not yet past the current revision's expiry. */
const livePending = (now: Date) => ({
  state: "PENDING",
  currentRevision: { is: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } },
})

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

type Slugs = { orgSlug: string; workspaceSlug: string }

/** Resolved BEFORE any row is written, so a missing workspace can never leave an orphan pending request behind. */
async function workspaceSlugsOf(prisma: AppPrismaClient, workspaceId: string): Promise<Slugs> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, organization: { select: { slug: true } } } })
  if (!workspace?.organization) throw new ToolApprovalError("WORKSPACE_REQUIRED", "Workspace not found.")
  return { orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug }
}

const requesterWhere = (requester: Requester) =>
  requester.agentId ? { requestedByAgentId: requester.agentId } : { requestedByAgentId: null, requestedById: requester.userId }

/** Same shape as createTrackedDecisionRequest: subjectType = gateType, one revision, ADMIN required, two options. */
export async function createToolApprovalRequest(
  prisma: AppPrismaClient,
  input: {
    workspaceId: string
    subjectId: string
    packet: EffectPacket
    title: string
    summary: string
    requestedById: string | null
    requestedByAgentId: string | null
    expiresAt: Date
  },
) {
  return withSequenceTransaction(prisma, async (tx) => {
    const request = await tx.reviewRequest.create({
      data: {
        workspaceId: input.workspaceId, gateType: TOOL_APPROVAL_GATE, subjectType: TOOL_APPROVAL_GATE, subjectId: input.subjectId,
        ...(await allocateOneSeq(tx, input.workspaceId, "reviewRequest")),
        state: "DRAFT", requestedById: input.requestedById, requestedByAgentId: input.requestedByAgentId, expiresAt: input.expiresAt,
      },
    })
    const revision = await tx.reviewRevision.create({
      data: {
        requestId: request.id, revisionNumber: 1, fingerprint: fingerprintOf(request.id, 1, 1, input.packet),
        title: clip(input.title, 255), summary: input.summary, packetJson: JSON.stringify(input.packet),
        requiredRole: "ADMIN", expiresAt: input.expiresAt, options: { create: approvalOptions },
      },
    })
    const current = await tx.reviewRequest.update({
      where: { id: request.id },
      data: { state: "PENDING", currentRevisionId: revision.id, revisionCount: 1, decisionCycle: 1, updatedAt: new Date() },
    })
    return { request: current, revision }
  })
}

type Slot =
  | { kind: "pending"; row: { id: string; seqPrefix: string | null; seqNumber: number | null; expiresAt: Date | null; currentRevision: { id: string; packetJson: string; expiresAt: Date | null; title: string; summary: string | null } | null } }
  | { kind: "free"; generation: number }

/** Finds the live pending request for this exact call, or the first unused generation to create the next one at. */
async function findSlot(prisma: AppPrismaClient, workspaceId: string, tool: string, argsHash: string, now: Date): Promise<Slot> {
  for (let base = 0; base < MAX_GENERATIONS; base += GENERATION_BATCH) {
    const ids = Array.from({ length: GENERATION_BATCH }, (_, i) => deterministicSubjectId(workspaceId, tool, argsHash, base + i))
    const rows = await prisma.reviewRequest.findMany({
      where: { workspaceId, gateType: TOOL_APPROVAL_GATE, subjectType: TOOL_APPROVAL_GATE, subjectId: { in: ids } },
      select: { id: true, subjectId: true, state: true, seqPrefix: true, seqNumber: true, expiresAt: true, currentRevision: { select: { id: true, packetJson: true, expiresAt: true, title: true, summary: true } } },
    })
    // The revision's expiry is the one recordDecision enforces, so it is the one that decides whether a request is still live.
    const live = rows.find((row) => row.state === "PENDING" && (!row.currentRevision?.expiresAt || row.currentRevision.expiresAt > now))
    if (live) return { kind: "pending", row: live }
    const used = new Set(rows.map((row) => row.subjectId))
    const free = ids.findIndex((id) => !used.has(id))
    if (free >= 0) return { kind: "free", generation: base + free }
  }
  throw new ToolApprovalError("GENERATIONS_EXHAUSTED", "Too many earlier approvals exist for this exact call.")
}

/**
 * The core of the MCP hook. For a registered tool: build the effect packet from LIVE state and either reuse the identical
 * pending request or create one. It never executes anything and has no path that does; execution belongs to the executor.
 * Everything is ASK until A4 adds policy. Throws ToolApprovalError / database errors; the hook turns every throw into a refusal.
 */
export async function requestToolApproval(input: { toolName: string; args: Record<string, unknown>; requester: Requester }): Promise<RequestToolApprovalOutcome> {
  const spec = getToolApprovalSpec(input.toolName)
  if (!spec) return { status: "NOT_REGISTERED" }
  const workspaceId = input.args.workspaceId
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) throw new ToolApprovalError("WORKSPACE_REQUIRED", "An approval needs a workspace id.")
  const prisma = getPrisma()
  const slugs = await workspaceSlugsOf(prisma, workspaceId)
  const pathFor = (requestId: string) => toolApprovalPath(slugs.orgSlug, slugs.workspaceSlug, requestId)
  const ctx: ToolApprovalContext = { workspaceId, prisma, requestedByUserId: input.requester.userId, requestedByAgentId: input.requester.agentId }

  const rawArgs = toJsonValue(input.args) as Record<string, unknown>
  const rawBefore = toJsonValue(await spec.readBefore(rawArgs, ctx))
  const floors = (await spec.floors?.(rawArgs, rawBefore, ctx)) ?? []
  if (floors.length) return { status: "BLOCKED", floors: floors.map(sanitizeText) }
  const { title, summary } = spec.describe(rawArgs, ctx)
  // Redaction is applied once, here: the stored packet, its fingerprint, the dedupe hash and the MCP result all see only redacted values.
  const redact = (kind: "args" | "before" | "after", value: Json): Json => (spec.redact ? toJsonValue(spec.redact(kind, value)) : value)
  const args = redact("args", rawArgs as Json) as Record<string, unknown>
  const before = redact("before", rawBefore)
  const after = redact("after", toJsonValue(spec.computeAfter(rawArgs, rawBefore)))
  const packet: EffectPacket = {
    schemaVersion: EFFECT_PACKET_SCHEMA_VERSION, tool: spec.toolName, capabilityClass: spec.capabilityClass, workspaceId, args: args as Json, before, after,
  }
  const argsHash = argsHashOf(spec.toolName, workspaceId, args)

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const now = new Date()
    const slot = await findSlot(prisma, workspaceId, spec.toolName, argsHash, now)
    if (slot.kind === "pending") {
      const stored = slot.row.currentRevision ? parseEffectPacket(slot.row.currentRevision.packetJson) : null
      if (stored && slot.row.currentRevision && stored.capabilityClass === spec.capabilityClass && sameJson(stored.before, before) && sameJson(stored.after, after)) {
        return {
          status: "APPROVAL_REQUIRED", requestId: slot.row.id, revisionId: slot.row.currentRevision.id,
          displayId: displayIdFromRow("reviewRequest", slot.row), path: pathFor(slot.row.id),
          title: slot.row.currentRevision.title, summary: slot.row.currentRevision.summary ?? "", before: stored.before, after: stored.after,
          expiresAt: slot.row.currentRevision.expiresAt, reused: true,
        }
      }
      // The world moved under a waiting request: an approval of the old before/after would only ever come back STALE.
      // Guarded on PENDING: if a human decided in the meantime this matches nothing, the decision stands untouched and (as it is no
      // longer pending) the loop moves on to the next generation instead of superseding an approval.
      const claimed = await prisma.reviewRequest.updateMany({ where: { id: slot.row.id, state: "PENDING" }, data: { state: "SUPERSEDED", updatedAt: now } })
      if (claimed.count === 1 && slot.row.currentRevision) await prisma.reviewRevision.updateMany({ where: { id: slot.row.currentRevision.id, supersededAt: null }, data: { supersededAt: now } })
      continue
    }
    const pendingCount = await prisma.reviewRequest.count({
      where: { workspaceId, gateType: TOOL_APPROVAL_GATE, ...livePending(now) },
    })
    if (pendingCount >= MAX_PENDING_TOOL_APPROVALS) {
      throw new ToolApprovalError("TOO_MANY_PENDING", `This workspace already has ${MAX_PENDING_TOOL_APPROVALS} approvals waiting. Ask an admin to review them first.`)
    }
    const requesterPending = await prisma.reviewRequest.count({ where: { workspaceId, gateType: TOOL_APPROVAL_GATE, ...livePending(now), ...requesterWhere(input.requester) } })
    if (requesterPending >= MAX_PENDING_PER_REQUESTER) {
      throw new ToolApprovalError("REQUESTER_LIMIT", `This caller already has ${MAX_PENDING_PER_REQUESTER} approvals waiting. Wait for an admin to decide them.`)
    }
    const expiresAt = new Date(now.getTime() + TOOL_APPROVAL_REQUEST_TTL_MS)
    try {
      const { request, revision } = await createToolApprovalRequest(prisma, {
        workspaceId, subjectId: deterministicSubjectId(workspaceId, spec.toolName, argsHash, slot.generation), packet, title, summary,
        requestedById: input.requester.userId, requestedByAgentId: input.requester.agentId, expiresAt,
      })
      return {
        status: "APPROVAL_REQUIRED", requestId: request.id, revisionId: revision.id, displayId: displayIdFromRow("reviewRequest", request),
        path: pathFor(request.id), title: revision.title, summary: revision.summary ?? "", before, after, expiresAt, reused: false,
      }
    } catch (error) {
      // A concurrent identical call took this generation: loop, find its pending request and reuse it.
      if ((error as { code?: string }).code === "P2002") continue
      throw error
    }
  }
  throw new ToolApprovalError("REQUEST_CONFLICT", "Could not settle on one approval request for this call; try again.")
}

export type PendingToolApprovalRow = {
  requestId: string
  displayId: string | null
  path: string
  tool: string
  capabilityClass: string
  title: string
  summary: string
  before: Json
  after: Json
  requestedByUserId: string | null
  requestedByAgentId: string | null
  createdAt: Date
  expiresAt: Date | null
}

/** Workspace admins only (including org admins): the queue the approval surface (A3) shows. */
export async function listPendingToolApprovals(workspaceId: string, actor: { userId: string }): Promise<PendingToolApprovalRow[]> {
  const prisma = getPrisma()
  if (!(await isWorkspaceAdminUser(prisma, actor.userId, workspaceId))) throw new ToolApprovalError("ADMIN_REQUIRED", "Workspace admin access is required.")
  const slugs = await workspaceSlugsOf(prisma, workspaceId)
  const rows = await prisma.reviewRequest.findMany({
    where: { workspaceId, gateType: TOOL_APPROVAL_GATE, ...livePending(new Date()) },
    include: { currentRevision: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_PENDING_TOOL_APPROVALS * 2,
  })
  const out: PendingToolApprovalRow[] = []
  for (const row of rows) {
    const packet = row.currentRevision ? parseEffectPacket(row.currentRevision.packetJson) : null
    if (!row.currentRevision || !packet) continue
    out.push({
      requestId: row.id, displayId: displayIdFromRow("reviewRequest", row), path: toolApprovalPath(slugs.orgSlug, slugs.workspaceSlug, row.id),
      tool: packet.tool, capabilityClass: packet.capabilityClass, title: row.currentRevision.title, summary: row.currentRevision.summary ?? "",
      before: packet.before, after: packet.after, requestedByUserId: row.requestedById, requestedByAgentId: row.requestedByAgentId,
      createdAt: row.createdAt, expiresAt: row.currentRevision.expiresAt,
    })
  }
  return out
}
