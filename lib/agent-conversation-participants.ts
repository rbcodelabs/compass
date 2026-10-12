/**
 * Participants in a shared agent conversation.
 *
 * The owner is `AgentConversation.userId` and has no row here; this table holds
 * PARTICIPANT rows only (see lib/agent-conversation-access.ts). Rules:
 *
 * - Any participant, and the owner, may invite. There is no cap.
 * - The invitee must be a live member of the conversation's workspace.
 * - The owner may remove anyone. A participant may remove only themself (leave).
 *   The owner cannot leave: ownership does not transfer, so a conversation always
 *   has its owner.
 * - Handoff/interview conversations stay single-user; inviting into one is refused.
 * - Removal is a soft delete (`removedAt`). Re-inviting clears it, so the unique
 *   (conversation, user) row is reused rather than colliding.
 * - Everything is a 404 to a caller with no access, never a 403, so a conversation
 *   the caller cannot see is indistinguishable from one that does not exist.
 *
 * The participants table arrives with migration 080. Until it is applied the read
 * paths degrade to "owner only" (`available: false`) instead of erroring, following
 * `agentRunsAvailable`.
 */

import type { AppPrismaClient } from "@/lib/db"
import { resolveConversationAccess, type ConversationRole } from "@/lib/agent-conversation-access"
import { sanitizeAuthorLabel } from "@/lib/agent-author-label"

export class AgentParticipantError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = "AgentParticipantError"
  }
}

export type ParticipantView = {
  userId: string
  role: ConversationRole
  /** Sanitized display name, the same string the agent sees in prompts. */
  name: string
  addedByUserId: string | null
}

export type CandidateView = { userId: string; name: string }

const AVAILABILITY_NEGATIVE_TTL_MS = 30_000
let availabilityCache: { value: boolean; checkedAt: number } | null = null

function isMissingTable(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "P2021" || error.code === "P2022")
}

/** False until migration 080 has created the table and the `author_user_id` column. */
export async function agentParticipantsAvailable(prisma: Pick<AppPrismaClient, "agentConversationParticipant">) {
  if (availabilityCache?.value) return true
  if (availabilityCache && Date.now() - availabilityCache.checkedAt < AVAILABILITY_NEGATIVE_TTL_MS) return false
  try {
    await prisma.agentConversationParticipant.findFirst({ select: { id: true } })
    availabilityCache = { value: true, checkedAt: Date.now() }
    return true
  } catch (error) {
    if (!isMissingTable(error)) throw error
    availabilityCache = { value: false, checkedAt: Date.now() }
    return false
  }
}

/** Test seam. */
export function resetAgentParticipantsAvailabilityCache() {
  availabilityCache = null
}

type Ctx = { conversationId: string; workspaceId: string; actorUserId: string }

async function requireAccess(prisma: AppPrismaClient, { conversationId, workspaceId, actorUserId }: Ctx) {
  const access = await resolveConversationAccess(prisma, { conversationId, workspaceId, userId: actorUserId })
  if (!access) throw new AgentParticipantError("Conversation not found", 404, "CONVERSATION_NOT_FOUND")
  return access
}

async function requireAvailable(prisma: AppPrismaClient) {
  if (!(await agentParticipantsAvailable(prisma))) {
    throw new AgentParticipantError("Shared conversations are not available yet", 503, "PARTICIPANTS_UNAVAILABLE")
  }
}

/**
 * Who is in the conversation, plus (optionally) which workspace members could still
 * be invited. Returns `null` if the caller has no access.
 */
export async function listConversationParticipants(
  prisma: AppPrismaClient,
  ctx: Ctx & { includeCandidates?: boolean }
): Promise<{
  available: boolean
  viewerRole: ConversationRole
  participants: ParticipantView[]
  candidates?: CandidateView[]
  shareable: boolean
} | null> {
  const access = await resolveConversationAccess(prisma, {
    conversationId: ctx.conversationId,
    workspaceId: ctx.workspaceId,
    userId: ctx.actorUserId,
  })
  if (!access) return null

  const conversation = await prisma.agentConversation.findUnique({
    where: { id: ctx.conversationId },
    select: { userId: true, interviewProcessingJson: true },
  })
  if (!conversation) return null
  const shareable = conversation.interviewProcessingJson === null

  const available = await agentParticipantsAvailable(prisma)
  const rows = available
    ? await prisma.agentConversationParticipant.findMany({
        where: { conversationId: ctx.conversationId, workspaceId: ctx.workspaceId, removedAt: null },
        orderBy: { createdAt: "asc" },
        select: { userId: true, addedByUserId: true },
      })
    : []

  const ids = [conversation.userId, ...rows.map((r) => r.userId)]
  // Live membership: a former workspace member stays out of the roster (they also
  // have no access — see the access predicate), rather than showing a ghost.
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId: ctx.workspaceId, userId: { in: ids } },
    select: { userId: true, user: { select: { name: true, email: true } } },
  })
  const byId = new Map(members.map((m) => [m.userId, sanitizeAuthorLabel(m.user.name, m.user.email)]))

  const participants: ParticipantView[] = [
    { userId: conversation.userId, role: "OWNER", name: byId.get(conversation.userId) ?? "Former member", addedByUserId: null },
    ...rows
      .filter((r) => byId.has(r.userId))
      .map((r) => ({ userId: r.userId, role: "PARTICIPANT" as const, name: byId.get(r.userId)!, addedByUserId: r.addedByUserId })),
  ]

  let candidates: CandidateView[] | undefined
  if (ctx.includeCandidates && available && shareable) {
    const taken = new Set(participants.map((p) => p.userId))
    const all = await prisma.workspaceMember.findMany({
      where: { workspaceId: ctx.workspaceId },
      select: { userId: true, user: { select: { name: true, email: true } } },
    })
    candidates = all
      .filter((m) => !taken.has(m.userId))
      .map((m) => ({ userId: m.userId, name: sanitizeAuthorLabel(m.user.name, m.user.email) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  return { available, viewerRole: access.role, participants, candidates, shareable }
}

/** Invite a workspace member. Idempotent: inviting someone already in is a no-op. */
export async function addConversationParticipant(
  prisma: AppPrismaClient,
  ctx: Ctx & { inviteeUserId: string; now?: Date }
): Promise<{ added: boolean }> {
  await requireAccess(prisma, ctx)
  await requireAvailable(prisma)
  const now = ctx.now ?? new Date()

  const conversation = await prisma.agentConversation.findUnique({
    where: { id: ctx.conversationId },
    select: { userId: true, interviewProcessingJson: true },
  })
  if (!conversation) throw new AgentParticipantError("Conversation not found", 404, "CONVERSATION_NOT_FOUND")
  if (conversation.interviewProcessingJson !== null) {
    throw new AgentParticipantError("This conversation cannot be shared", 409, "CONVERSATION_NOT_SHAREABLE")
  }
  if (ctx.inviteeUserId === conversation.userId) return { added: false }

  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId: ctx.workspaceId, userId: ctx.inviteeUserId },
    select: { userId: true },
  })
  if (!member) throw new AgentParticipantError("That person is not a member of this workspace", 422, "INVITEE_NOT_MEMBER")

  const existing = await prisma.agentConversationParticipant.findFirst({
    where: { conversationId: ctx.conversationId, userId: ctx.inviteeUserId },
    select: { id: true, removedAt: true },
  })
  if (existing && existing.removedAt === null) return { added: false }
  if (existing) {
    await prisma.agentConversationParticipant.update({
      where: { id: existing.id },
      data: { removedAt: null, addedByUserId: ctx.actorUserId, updatedAt: now },
    })
    return { added: true }
  }
  try {
    await prisma.agentConversationParticipant.create({
      data: {
        conversationId: ctx.conversationId,
        workspaceId: ctx.workspaceId,
        userId: ctx.inviteeUserId,
        role: "PARTICIPANT",
        addedByUserId: ctx.actorUserId,
        createdAt: now,
        updatedAt: now,
      },
    })
  } catch (error) {
    // Two people inviting the same person at once: the unique index makes the loser
    // fail, and the outcome they wanted (invitee is in) is true.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return { added: false }
    throw error
  }
  return { added: true }
}

/**
 * Remove a participant, or leave. `targetUserId === actorUserId` is leaving. Returns
 * `removed: false` when the target was not an active participant.
 */
export async function removeConversationParticipant(
  prisma: AppPrismaClient,
  ctx: Ctx & { targetUserId: string; now?: Date }
): Promise<{ removed: boolean; left: boolean }> {
  const access = await requireAccess(prisma, ctx)
  await requireAvailable(prisma)
  const now = ctx.now ?? new Date()
  const left = ctx.targetUserId === ctx.actorUserId

  if (left && access.role === "OWNER") {
    throw new AgentParticipantError("The owner cannot leave their own conversation", 409, "OWNER_CANNOT_LEAVE")
  }
  if (!left && access.role !== "OWNER") {
    throw new AgentParticipantError("Only the conversation owner can remove other people", 403, "REMOVE_FORBIDDEN")
  }

  const result = await prisma.agentConversationParticipant.updateMany({
    where: { conversationId: ctx.conversationId, userId: ctx.targetUserId, removedAt: null },
    data: { removedAt: now, updatedAt: now },
  })
  return { removed: result.count > 0, left }
}
