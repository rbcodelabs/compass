/**
 * Links between agent conversations and the Opportunities, Solutions and Tasks they touch (RM-19), on the generic `entity_links`
 * table: CONVERSATION_CREATED (the conversation's tools created the object) and CONVERSATION_MENTIONS (they read or updated an existing
 * one). Lives in lib/links/ because it is the one place besides the generic service that may name the EntityLink model.
 *
 * WRITES are automatic. The MCP tool dispatcher (app/api/mcp/route.ts `register`) calls `linkAgentToolCall` after every tool; the
 * declarative table in `deriveConversationTargets` is the only place that says which tool touches which object. Rules:
 *  - Only an AGENT_TURN actor links, to the conversation resolved from its live run (never a tool argument).
 *  - A CREATED link is never downgraded: a later read or update leaves it alone, and a create replaces an earlier MENTIONS link.
 *  - Idempotent (the pair is unique); source AGENT marks it automatic, origin DIRECT.
 *  - It can never fail a tool call: `linkAgentToolCall` swallows and logs every error. No chat text is parsed.
 *
 * READS apply the conversation access rules (lib/agent-conversation-access.ts): a viewer sees a conversation on an object only when
 * they may open that conversation, and a conversation's linked objects only when they may open the conversation. Titles are never
 * returned for a conversation the viewer cannot access, so the internal link types stay out of the generic reads.
 */
import type { AppPrismaClient } from "@/lib/db"
import getPrisma from "@/lib/db"
import { accessibleConversationsWhere, resolveConversationAccess } from "@/lib/agent-conversation-access"
import { currentAgentConversation } from "@/lib/agent-turn-conversation"
import { getMcpActor } from "@/lib/mcp-authz"
import { resolveEndpoints } from "@/lib/links/endpoints"
import { CONVERSATION_CREATED_LINK_TYPE, CONVERSATION_LINK_TARGET_TYPES, CONVERSATION_MENTIONS_LINK_TYPE } from "@/lib/links/registry"
import { linkEntities, unlinkEntities } from "@/lib/links/service"
import { runTypedLinkTransaction } from "@/lib/typed-links"

export type ConversationLinkKind = "CREATED" | "MENTIONS"
export type ConversationLinkTarget = (typeof CONVERSATION_LINK_TARGET_TYPES)[number]

const LINK_TYPE: Record<ConversationLinkKind, string> = { CREATED: CONVERSATION_CREATED_LINK_TYPE, MENTIONS: CONVERSATION_MENTIONS_LINK_TYPE }
const KIND_OF_TYPE: Record<string, ConversationLinkKind> = { [CONVERSATION_CREATED_LINK_TYPE]: "CREATED", [CONVERSATION_MENTIONS_LINK_TYPE]: "MENTIONS" }
const BOTH_TYPES = [CONVERSATION_CREATED_LINK_TYPE, CONVERSATION_MENTIONS_LINK_TYPE]
/** Upper bound on links read for one conversation or one object. */
const READ_CAP = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isConversationLinkTarget = (type: string): type is ConversationLinkTarget => (CONVERSATION_LINK_TARGET_TYPES as readonly string[]).includes(type)

// ── Writes ──────────────────────────────────────────────────────────────────

export type RecordConversationLinkInput = {
  conversationId: string
  workspaceId: string
  entityType: ConversationLinkTarget
  entityId: string
  kind: ConversationLinkKind
}

/**
 * Creates the link unless an equal-or-stronger one exists. MENTIONS never replaces or sits beside CREATED; CREATED removes a MENTIONS
 * link for the same pair first. Returns "created" when a row was written, otherwise "unchanged". Throws on a missing endpoint (the
 * caller `linkAgentToolCall` logs it).
 */
export async function recordConversationLink(prisma: AppPrismaClient, input: RecordConversationLinkInput): Promise<"created" | "unchanged"> {
  const { conversationId, workspaceId, entityType, entityId, kind } = input
  return runTypedLinkTransaction(prisma, async (tx) => {
    if (kind === "MENTIONS") {
      const stronger = await tx.entityLink.findFirst({ where: { fromId: conversationId, linkType: CONVERSATION_CREATED_LINK_TYPE, toId: entityId }, select: { id: true } })
      if (stronger) return "unchanged" as const
    } else {
      await unlinkEntities(tx, { linkType: CONVERSATION_MENTIONS_LINK_TYPE, fromId: conversationId, toId: entityId, expectedWorkspaceId: workspaceId, viaInternalWriter: true })
    }
    const result = await linkEntities(tx, {
      linkType: LINK_TYPE[kind],
      fromId: conversationId,
      toId: entityId,
      toType: entityType,
      expectedWorkspaceId: workspaceId,
      origin: "DIRECT",
      ctx: { source: "AGENT", createdById: null },
      viaInternalWriter: true,
    })
    return result.created ? ("created" as const) : ("unchanged" as const)
  })
}

export type ConversationTarget = { entityType: ConversationLinkTarget; entityId: string; kind: ConversationLinkKind }

type ToolResult = { structuredContent?: { ok?: boolean; data?: unknown } } | null | undefined

const str = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value : null)
const dataOf = (result: ToolResult): Record<string, unknown> => {
  const data = result?.structuredContent?.data
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {}
}
/** Ids from a bulk create result: created rows are CREATED, rows that already existed (deduped) are only mentioned. */
function batchTargets(entityType: ConversationLinkTarget, result: ToolResult): ConversationTarget[] {
  const rows = dataOf(result).results
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row: { ok?: boolean; id?: unknown; deduped?: unknown }) => {
    const id = row?.ok ? str(row.id) : null
    return id ? [{ entityType, entityId: id, kind: row.deduped ? ("MENTIONS" as const) : ("CREATED" as const) }] : []
  })
}
const created = (entityType: ConversationLinkTarget, result: ToolResult): ConversationTarget[] => {
  const id = str(dataOf(result).id)
  return id ? [{ entityType, entityId: id, kind: "CREATED" }] : []
}
const mention = (entityType: ConversationLinkTarget, id: unknown): ConversationTarget[] => {
  const entityId = str(id)
  return entityId ? [{ entityType, entityId, kind: "MENTIONS" }] : []
}

/**
 * Which objects a successful tool call created or touched. THE table: a new tool that should link adds one line here and nothing else.
 * Args arrive with display ids already resolved to UUIDs (the dispatcher resolves them before the handler runs).
 */
export function deriveConversationTargets(toolName: string, args: Record<string, unknown>, result: ToolResult): ConversationTarget[] {
  if (!result?.structuredContent?.ok) return []
  switch (toolName) {
    case "create_opportunity": return created("OPPORTUNITY", result)
    case "create_opportunities": return batchTargets("OPPORTUNITY", result)
    case "add_solution": return [...created("SOLUTION", result), ...mention("OPPORTUNITY", args.opportunityId)]
    case "create_solutions": return batchTargets("SOLUTION", result)
    case "create_task":
    case "TaskCreate": return created("TASK", result)
    case "get_opportunity":
    case "update_opportunity":
    case "update_opportunity_status": return mention("OPPORTUNITY", args.opportunityId)
    case "update_solution":
    case "update_solution_status": return mention("SOLUTION", args.solutionId)
    case "get_task":
    case "update_task":
    case "move_task_status": return mention("TASK", args.taskId)
    default: return []
  }
}

/**
 * The dispatcher hook. Call it with the tool's resolved args and its result; it does nothing unless the caller is an agent turn and the
 * tool is in the table, and it NEVER throws or delays the tool's outcome beyond the link write (failures are logged by name only).
 */
export async function linkAgentToolCall(toolName: string, args: Record<string, unknown>, result: ToolResult): Promise<void> {
  try {
    if (getMcpActor().purpose !== "AGENT_TURN") return
    const targets = deriveConversationTargets(toolName, args ?? {}, result)
    if (targets.length === 0) return
    const conversation = await currentAgentConversation()
    if (!conversation) return
    const prisma = getPrisma()
    for (const target of targets) {
      try {
        await recordConversationLink(prisma, { ...conversation, ...target })
      } catch (error) {
        logLinkFailure(toolName, target, error)
      }
    }
  } catch (error) {
    logLinkFailure(toolName, null, error)
  }
}

function logLinkFailure(toolName: string, target: ConversationTarget | null, error: unknown) {
  const e = error as { name?: string; code?: string } | null
  console.error(JSON.stringify({ event: "conversation_link.failed", tool: toolName, entityType: target?.entityType ?? null, kind: target?.kind ?? null, name: e?.name ?? "Error", code: e?.code ?? null }))
}

// ── Reads ───────────────────────────────────────────────────────────────────

type LinkRow = { id: string; linkType: string; fromId: string; toType: string; toId: string; source: string; origin: string; createdAt: Date }

export type ConversationObjectLink = {
  linkId: string
  kind: ConversationLinkKind
  /** True when the agent made it on its own (source AGENT) or the backfill derived it; both are removable by a workspace member. */
  auto: boolean
  entityType: ConversationLinkTarget
  entityId: string
  title: string
}

export type ObjectConversationLink = {
  linkId: string
  kind: ConversationLinkKind
  auto: boolean
  conversationId: string
  title: string
  archived: boolean
}

const isAuto = (row: { source: string; origin: string }) => row.source === "AGENT" || row.origin === "MIGRATION"
/** CREATED before MENTIONS, then oldest first. */
const byKindThenAge = (a: { kind: ConversationLinkKind; at: number }, b: { kind: ConversationLinkKind; at: number }) => (a.kind === b.kind ? a.at - b.at : a.kind === "CREATED" ? -1 : 1)

/**
 * The objects a conversation created or touched, or null when the viewer may not open the conversation (the route answers 404). An
 * object that is gone or not in the workspace is left out.
 */
export async function listObjectsForConversation(
  prisma: AppPrismaClient,
  { conversationId, workspaceId, userId }: { conversationId: string; workspaceId: string; userId: string },
): Promise<ConversationObjectLink[] | null> {
  if (!(await resolveConversationAccess(prisma, { conversationId, workspaceId, userId }))) return null
  const rows = (await prisma.entityLink.findMany({
    where: { workspaceId, linkType: { in: BOTH_TYPES }, fromId: conversationId },
    select: { id: true, linkType: true, fromId: true, toType: true, toId: true, source: true, origin: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: READ_CAP,
  })) as LinkRow[]
  const titles = new Map<string, string>()
  for (const type of CONVERSATION_LINK_TARGET_TYPES) {
    const ids = rows.filter((row) => row.toType === type).map((row) => row.toId)
    for (const [id, endpoint] of await resolveEndpoints(prisma, type, workspaceId, ids)) titles.set(`${type}:${id}`, endpoint.title)
  }
  return rows
    .flatMap((row) => {
      const title = titles.get(`${row.toType}:${row.toId}`)
      if (title === undefined || !isConversationLinkTarget(row.toType)) return []
      const kind = KIND_OF_TYPE[row.linkType]
      return [{ linkId: row.id, kind, auto: isAuto(row), entityType: row.toType, entityId: row.toId, title, at: row.createdAt.getTime() }]
    })
    .sort(byKindThenAge)
    .map(({ linkId, kind, auto, entityType, entityId, title }) => ({ linkId, kind, auto, entityType, entityId, title }))
}

/**
 * The conversations linked to one object that THIS viewer may open (owner or active participant, live workspace member). Others are
 * omitted entirely, so neither their titles nor their existence leaks. Empty when the object is not in the workspace.
 */
export async function listConversationsForObject(
  prisma: AppPrismaClient,
  { workspaceId, entityType, entityId, userId }: { workspaceId: string; entityType: ConversationLinkTarget; entityId: string; userId: string },
): Promise<ObjectConversationLink[]> {
  if (!(await resolveEndpoints(prisma, entityType, workspaceId, [entityId])).has(entityId)) return []
  const rows = (await prisma.entityLink.findMany({
    where: { workspaceId, linkType: { in: BOTH_TYPES }, toType: entityType, toId: entityId },
    select: { id: true, linkType: true, fromId: true, toType: true, toId: true, source: true, origin: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: READ_CAP,
  })) as LinkRow[]
  if (rows.length === 0) return []
  const visible = await prisma.agentConversation.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.fromId))] }, ...accessibleConversationsWhere(workspaceId, userId) },
    select: { id: true, title: true, archivedAt: true },
  })
  const byId = new Map(visible.map((conversation) => [conversation.id, conversation]))
  return rows
    .flatMap((row) => {
      const conversation = byId.get(row.fromId)
      if (!conversation) return []
      return [{ linkId: row.id, kind: KIND_OF_TYPE[row.linkType], auto: isAuto(row), conversationId: conversation.id, title: conversation.title?.trim() || "Agent conversation", archived: Boolean(conversation.archivedAt), at: row.createdAt.getTime() }]
    })
    .sort(byKindThenAge)
    .map(({ linkId, kind, auto, conversationId, title, archived }) => ({ linkId, kind, auto, conversationId, title, archived }))
}

/**
 * Removes one conversation link. The caller has already proven workspace membership (the write access). The viewer must also be able to
 * open the conversation, so a link to a private conversation cannot be probed or removed by someone who cannot see it. Returns false for
 * anything missing, foreign or not accessible (indistinguishable on purpose).
 */
export async function removeConversationLink(prisma: AppPrismaClient, { linkId, workspaceId, userId }: { linkId: string; workspaceId: string; userId: string }): Promise<boolean> {
  const row = await prisma.entityLink.findFirst({
    where: { id: linkId, workspaceId, linkType: { in: BOTH_TYPES } },
    select: { linkType: true, fromId: true, toId: true },
  })
  if (!row) return false
  if (!(await resolveConversationAccess(prisma, { conversationId: row.fromId, workspaceId, userId }))) return false
  const result = await runTypedLinkTransaction(prisma, (tx) =>
    unlinkEntities(tx, { linkType: row.linkType, fromId: row.fromId, toId: row.toId, expectedWorkspaceId: workspaceId, viaInternalWriter: true }),
  )
  return result.removed > 0
}
