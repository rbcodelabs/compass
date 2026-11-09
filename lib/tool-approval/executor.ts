import getPrisma, { type AppPrismaClient } from "@/lib/db"
import { isWorkspaceAdminUser } from "@/lib/agent-ownership"
import { runWithMcpActor } from "@/lib/mcp-authz"
import { EXECUTE_TOOL_APPROVAL_CONTINUATION, TOOL_APPROVAL_GATE } from "@/lib/tool-approval/gate"
import { fingerprintOf, parseEffectPacket, receiptKeyOf, sameJson, toJsonValue, type Json } from "@/lib/tool-approval/packet"
import { getToolApprovalSpec, type ToolApprovalContext, type ToolApprovalExecuteContext } from "@/lib/tool-approval/registry"

/** An approval can only cause execution this long after it was given. Older approvals need a fresh decision. */
export const TOOL_APPROVAL_EXECUTION_WINDOW_MS = 15 * 60 * 1000

export type RefusalReason =
  | "NO_DECISION" | "WRONG_GATE" | "NOT_CURRENT" | "NOT_AN_APPROVAL" | "PACKET_INVALID" | "FINGERPRINT_MISMATCH"
  | "WORKSPACE_MISMATCH" | "TOOL_NOT_REGISTERED" | "TOOL_MISMATCH" | "APPROVER_NOT_ADMIN_NOW" | "EXPIRED" | "APPROVAL_STALE"

export type ExecuteOutcome =
  | { status: "EXECUTED"; receiptId: string; result: Json }
  | { status: "FAILED"; receiptId: string; error: string }
  /** The live before-state no longer equals the approved one. Nothing ran; a fresh approval is needed. */
  | { status: "STALE"; receiptId: string }
  /** A hard floor blocks the call regardless of approval. Nothing ran. */
  | { status: "BLOCKED"; receiptId: string; floors: string[] }
  | { status: "ALREADY_APPLIED"; receiptStatus: string }
  | { status: "REFUSED"; reason: RefusalReason }

/**
 * Receipt-first, one terminal outcome per decision. Once a decision passes static verification a DecisionApplication row is
 * claimed (unique receiptKey) BEFORE anything else happens, so two racing executors yield exactly one winner. The row ends as
 * APPLIED, FAILED, STALE or BLOCKED and never returns to PENDING. Retry semantics: none. A FAILED/STALE/BLOCKED (or crashed,
 * still PENDING) receipt is final; running the call again requires a brand-new approval request and decision.
 */
export function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "Error: execution failed"
  return raw
    .split("\n")[0]
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .replace(/(?:\/[\w.@-]+){2,}(?::\d+){0,2}/g, "[path]")
    .slice(0, 300)
}

async function receiptStatusOf(prisma: AppPrismaClient, decisionId: string): Promise<string> {
  const row = await prisma.decisionApplication.findUnique({ where: { receiptKey: receiptKeyOf(decisionId) }, select: { status: true } })
  return row?.status ?? "PENDING"
}

/**
 * Runs the approved tool call for ONE decision. The decision id is the only input and nothing else is trusted: the packet, the
 * tool, the workspace and the approver all come from the database and are re-verified now. See ExecuteOutcome for results.
 */
export async function executeApprovedToolCall(decisionId: string): Promise<ExecuteOutcome> {
  const prisma = getPrisma()
  const refuse = (reason: RefusalReason): ExecuteOutcome => ({ status: "REFUSED", reason })
  const now = new Date()

  const decision = await prisma.decisionRecord.findUnique({ where: { id: decisionId }, include: { option: true, revision: { include: { request: true } } } })
  if (!decision) return refuse("NO_DECISION")
  const { revision } = decision
  const request = revision.request
  if (request.gateType !== TOOL_APPROVAL_GATE) return refuse("WRONG_GATE")
  if (request.state !== "DECIDED" || request.currentRevisionId !== revision.id || revision.supersededAt) return refuse("NOT_CURRENT")
  if (decision.option.outcomeClass !== "APPROVE" || decision.option.continuationKey !== EXECUTE_TOOL_APPROVAL_CONTINUATION) return refuse("NOT_AN_APPROVAL")

  let storedPacket: unknown
  try { storedPacket = JSON.parse(revision.packetJson) } catch { return refuse("PACKET_INVALID") }
  const fingerprint = fingerprintOf(request.id, request.decisionCycle, revision.revisionNumber, storedPacket)
  if (fingerprint !== decision.fingerprint || fingerprint !== revision.fingerprint) return refuse("FINGERPRINT_MISMATCH")
  const packet = parseEffectPacket(revision.packetJson)
  if (!packet) return refuse("PACKET_INVALID")
  if (packet.workspaceId !== request.workspaceId || decision.workspaceId !== request.workspaceId) return refuse("WORKSPACE_MISMATCH")
  const spec = getToolApprovalSpec(packet.tool)
  if (!spec) return refuse("TOOL_NOT_REGISTERED")
  if (spec.toolName !== packet.tool || spec.capabilityClass !== packet.capabilityClass) return refuse("TOOL_MISMATCH")
  if (!(await isWorkspaceAdminUser(prisma, decision.actorUserId, request.workspaceId))) return refuse("APPROVER_NOT_ADMIN_NOW")
  if (revision.expiresAt && revision.expiresAt <= now) return refuse("EXPIRED")
  if (decision.decidedAt.getTime() + TOOL_APPROVAL_EXECUTION_WINDOW_MS <= now.getTime()) return refuse("APPROVAL_STALE")

  const receiptKey = receiptKeyOf(decision.id)
  if (await prisma.decisionApplication.findUnique({ where: { receiptKey }, select: { id: true } })) {
    return { status: "ALREADY_APPLIED", receiptStatus: await receiptStatusOf(prisma, decision.id) }
  }

  let receiptId: string
  try {
    receiptId = (await prisma.decisionApplication.create({
      data: { decisionId: decision.id, continuationKey: EXECUTE_TOOL_APPROVAL_CONTINUATION, targetType: TOOL_APPROVAL_GATE, targetId: request.id, status: "PENDING", receiptKey, attemptCount: 1, updatedAt: now },
      select: { id: true },
    })).id
  } catch (error) {
    // A racing executor claimed it first: it owns the outcome, this one must do nothing.
    if ((error as { code?: string }).code === "P2002") return { status: "ALREADY_APPLIED", receiptStatus: await receiptStatusOf(prisma, decision.id) }
    throw error
  }
  const settle = (status: string, extra: { lastError?: string; appliedAt?: Date } = {}) =>
    prisma.decisionApplication.update({ where: { id: receiptId }, data: { status, updatedAt: new Date(), ...extra } })

  const baseContext: ToolApprovalContext = { workspaceId: request.workspaceId, prisma, requestedByUserId: request.requestedById, requestedByAgentId: request.requestedByAgentId }
  const args = packet.args as Record<string, unknown>
  try {
    const liveBefore = toJsonValue(await spec.readBefore(args, baseContext))
    const floors = (await spec.floors?.(args, liveBefore, baseContext)) ?? []
    if (floors.length) {
      await settle("BLOCKED", { lastError: floors.join("; ").slice(0, 500) })
      return { status: "BLOCKED", receiptId, floors }
    }
    if (!sameJson(liveBefore, packet.before)) {
      await settle("STALE", { lastError: "The state changed after approval." })
      return { status: "STALE", receiptId }
    }
    const executeContext: ToolApprovalExecuteContext = { ...baseContext, approverUserId: decision.actorUserId, decisionId: decision.id, requestId: request.id }
    // The write is attributed to the approving admin, not to the (agent) requester: they are the human authority for this change.
    const result = toJsonValue(await runWithMcpActor({ userId: decision.actorUserId, purpose: "USER", authorizedWorkspaceId: request.workspaceId }, () => spec.execute(args, executeContext)))
    try {
      await settle("APPLIED", { appliedAt: new Date() })
    } catch {
      console.error("Tool approval ran but its receipt could not be finalised", { decisionId: decision.id })
    }
    return { status: "EXECUTED", receiptId, result }
  } catch (error) {
    const message = sanitizeError(error)
    try { await settle("FAILED", { lastError: message }) } catch { console.error("Tool approval failed and its receipt could not be finalised", { decisionId: decision.id }) }
    return { status: "FAILED", receiptId, error: message }
  }
}
