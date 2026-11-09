/**
 * Read model for the approval surfaces (page, list, chat card). Everything shown comes from the STORED request: the revision's
 * title and summary (written by the registry's describe() at request time) and the immutable effect packet. Nothing is taken
 * from agent text or from a caller. Plain serialisable data (ISO strings), so it can cross into client components.
 */
import type { Prisma } from "@prisma/client"
import type { AppPrismaClient } from "@/lib/db"
import { displayIdFromRow } from "@/lib/work-item-ids"
import { TOOL_APPROVAL_GATE, toolApprovalPath } from "@/lib/tool-approval/gate"
import { parseEffectPacket, type Json } from "@/lib/tool-approval/packet"
import { getToolApprovalSpec } from "@/lib/tool-approval/registry"
import { sanitizeText } from "@/lib/tool-approval/sanitize"
import { deriveApprovalState, type ApprovalStateInfo } from "@/lib/tool-approval/state"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value)

export const RECENT_APPROVALS_LIMIT = 20

export type ApprovalView = {
  requestId: string
  displayId: string | null
  /** `/org/workspace/approvals/id` */
  path: string
  tool: string
  capabilityClass: string
  title: string
  summary: string
  args: Json
  before: Json
  after: Json
  state: ApprovalStateInfo
  requestedBy: "agent" | "person" | "service"
  createdAt: string
  expiresAt: string | null
  decision: { approved: boolean; decidedAt: string; decidedByName: string | null } | null
  /** The executor's receipt, when one exists. `error` is sanitised again here. */
  receipt: { status: string; appliedAt: string | null; error: string | null } | null
}

const requestInclude = {
  workspace: { select: { slug: true, organization: { select: { slug: true } } } },
  currentRevision: {
    include: {
      decisions: {
        include: { option: true, applications: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { decidedAt: "asc" },
        take: 1,
      },
    },
  },
} satisfies Prisma.ReviewRequestInclude

type RequestRow = Prisma.ReviewRequestGetPayload<{ include: typeof requestInclude }>

async function namesOf(prisma: AppPrismaClient, userIds: string[]): Promise<Map<string, string>> {
  if (!userIds.length) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(userIds)] } }, select: { id: true, name: true, email: true } })
  return new Map(users.map((user) => [user.id, user.name?.trim() || user.email || "Workspace admin"]))
}

function toView(row: RequestRow, names: Map<string, string>, now: Date): ApprovalView | null {
  const revision = row.currentRevision
  const packet = revision ? parseEffectPacket(revision.packetJson) : null
  if (!revision || !packet) return null
  const decision = revision.decisions[0] ?? null
  const receipt = decision?.applications[0] ?? null
  const state = deriveApprovalState({
    requestState: row.state, revisionSupersededAt: revision.supersededAt, revisionExpiresAt: revision.expiresAt,
    decision: decision ? { outcomeClass: decision.option.outcomeClass, decidedAt: decision.decidedAt } : null,
    receipt: receipt ? { status: receipt.status, updatedAt: receipt.updatedAt } : null,
    toolRegistered: Boolean(getToolApprovalSpec(packet.tool)), now,
  })
  const org = row.workspace.organization
  return {
    requestId: row.id, displayId: displayIdFromRow("reviewRequest", row), path: org ? toolApprovalPath(org.slug, row.workspace.slug, row.id) : "",
    tool: packet.tool, capabilityClass: packet.capabilityClass, title: revision.title, summary: revision.summary ?? "",
    args: packet.args, before: packet.before, after: packet.after, state,
    requestedBy: row.requestedByAgentId ? "agent" : row.requestedById ? "person" : "service",
    createdAt: row.createdAt.toISOString(), expiresAt: revision.expiresAt?.toISOString() ?? null,
    decision: decision ? { approved: decision.option.outcomeClass === "APPROVE", decidedAt: decision.decidedAt.toISOString(), decidedByName: names.get(decision.actorUserId) ?? null } : null,
    receipt: receipt ? { status: receipt.status, appliedAt: receipt.appliedAt?.toISOString() ?? null, error: receipt.lastError ? sanitizeText(receipt.lastError) : null } : null,
  }
}

const decidedBy = (rows: RequestRow[]): string[] => rows.flatMap((row) => row.currentRevision?.decisions.map((decision) => decision.actorUserId) ?? [])

/**
 * One approval, scoped to a workspace. Null when the id is not a uuid, is not a tool approval, belongs to another workspace
 * (the IDOR check: the id alone never selects a row), or its stored packet cannot be read.
 */
export async function loadApprovalView(prisma: AppPrismaClient, input: { requestId: string; workspaceId: string; now?: Date }): Promise<ApprovalView | null> {
  if (!isUuid(input.requestId) || !isUuid(input.workspaceId)) return null
  const row = await prisma.reviewRequest.findFirst({ where: { id: input.requestId, workspaceId: input.workspaceId, gateType: TOOL_APPROVAL_GATE }, include: requestInclude })
  if (!row) return null
  return toView(row, await namesOf(prisma, decidedBy([row])), input.now ?? new Date())
}

/** Newest first: everything that is no longer waiting (decided, expired unanswered, replaced). */
export async function loadRecentApprovals(prisma: AppPrismaClient, workspaceId: string, now = new Date()): Promise<ApprovalView[]> {
  if (!isUuid(workspaceId)) return []
  const rows = await prisma.reviewRequest.findMany({
    where: { workspaceId, gateType: TOOL_APPROVAL_GATE, OR: [{ state: { not: "PENDING" } }, { currentRevision: { is: { expiresAt: { lte: now } } } }] },
    include: requestInclude,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: RECENT_APPROVALS_LIMIT,
  })
  const names = await namesOf(prisma, decidedBy(rows))
  return rows.flatMap((row) => { const view = toView(row, names, now); return view ? [view] : [] })
}
