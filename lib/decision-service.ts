import getPrisma from "@/lib/db"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"

export type DecisionActor = { kind: "SERVICE" } | { kind: "USER"; userId: string }

export class DecisionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "DecisionError"
  }
}

type DecisionIdentity = {
  actorUserId: string
  revisionId: string
  optionId: string
  fingerprint: string
}

function assertIdempotentIdentity(existing: DecisionIdentity, expected: DecisionIdentity): void {
  if (
    existing.actorUserId !== expected.actorUserId ||
    existing.revisionId !== expected.revisionId ||
    existing.optionId !== expected.optionId ||
    existing.fingerprint !== expected.fingerprint
  ) {
    throw new DecisionError("IDEMPOTENCY_KEY_CONFLICT", "This idempotency key belongs to a different decision submission.")
  }
}

function assertConcurrentWinnerIdentity(winner: DecisionIdentity, expected: DecisionIdentity): void {
  if (
    winner.actorUserId !== expected.actorUserId ||
    winner.revisionId !== expected.revisionId ||
    winner.optionId !== expected.optionId ||
    winner.fingerprint !== expected.fingerprint
  ) {
    throw new DecisionError("ALREADY_DECIDED", "A different terminal decision won this revision.")
  }
}

async function repairRequestStateIfRevisionIsCurrent(tx: ReturnType<typeof getPrisma>, replay: DecisionIdentity & { requestId: string }): Promise<void> {
  const request = await tx.reviewRequest.findUnique({ where: { id: replay.requestId }, select: { currentRevisionId: true, state: true } })
  if (request?.currentRevisionId === replay.revisionId && request.state !== "DECIDED") {
    await tx.reviewRequest.update({ where: { id: replay.requestId }, data: { state: "DECIDED", updatedAt: new Date() } })
  }
}

export async function recordDecision(input: {
  actor: DecisionActor
  revisionId: string
  fingerprint: string
  optionId: string
  rationale?: string
  idempotencyKey: string
}) {
  if (input.actor.kind !== "USER") {
    throw new DecisionError("HUMAN_ACTOR_REQUIRED", "An authenticated human must take this decision.")
  }
  const actorUserId = input.actor.userId
  const prisma = getPrisma()
  const expectedIdentity = { actorUserId, revisionId: input.revisionId, optionId: input.optionId, fingerprint: input.fingerprint }
  try {
    return await prisma.$transaction(async (tx) => {
      const replay = await tx.decisionRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (replay) {
        assertIdempotentIdentity(replay, expectedIdentity)
        await repairRequestStateIfRevisionIsCurrent(tx as ReturnType<typeof getPrisma>, replay)
        return replay
      }

      const revision = await tx.reviewRevision.findUnique({
        where: { id: input.revisionId },
        include: { request: true, options: true },
      })
      if (!revision) throw new DecisionError("REVISION_NOT_FOUND", "Review revision not found.")
      if (revision.fingerprint !== input.fingerprint) {
        throw new DecisionError("STALE_FINGERPRINT", "The review packet changed. Refresh before deciding.")
      }
      if (revision.supersededAt || revision.request.state !== "PENDING") {
        throw new DecisionError("REVISION_NOT_PENDING", "This review revision is no longer pending.")
      }
      if (revision.expiresAt && revision.expiresAt <= new Date()) {
        throw new DecisionError("REVISION_EXPIRED", "This review revision has expired.")
      }
      const option = revision.options.find((candidate) => candidate.id === input.optionId)
      if (!option) throw new DecisionError("OPTION_MISMATCH", "The selected option is not part of this revision.")

      const [workspaceMember, orgMember] = await Promise.all([
        tx.workspaceMember.findFirst({ where: { workspaceId: revision.request.workspaceId, userId: actorUserId }, select: { role: true } }),
        tx.organizationMember.findFirst({ where: { userId: actorUserId, organization: { workspaces: { some: { id: revision.request.workspaceId } } } }, select: { role: true } }),
      ])
      const actorRole = isOrgAdminRole(orgMember?.role) ? "ADMIN" : normalizeWorkspaceRole(workspaceMember?.role)
      if (!workspaceMember && !orgMember) throw new DecisionError("ACCESS_DENIED", "Workspace not found or access denied.")
      if (revision.requiredRole === "ADMIN" && actorRole !== "ADMIN") throw new DecisionError("ADMIN_REQUIRED", "Workspace admin approval is required.")

      const terminal = await tx.decisionRecord.findFirst({ where: { revisionId: revision.id } })
      if (terminal) throw new DecisionError("ALREADY_DECIDED", "A terminal decision already exists for this revision.")

      const decision = await tx.decisionRecord.create({
        data: {
          workspaceId: revision.request.workspaceId, requestId: revision.requestId, revisionId: revision.id,
          optionId: option.id, fingerprint: revision.fingerprint, actorUserId, actorRole,
          rationale: input.rationale?.trim() || null, idempotencyKey: input.idempotencyKey,
        },
      })
      await tx.reviewRequest.update({ where: { id: revision.requestId }, data: { state: "DECIDED", updatedAt: new Date() } })
      return decision
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const replay = await prisma.decisionRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (replay) {
        assertIdempotentIdentity(replay, expectedIdentity)
        await prisma.$transaction((tx) => repairRequestStateIfRevisionIsCurrent(tx as ReturnType<typeof getPrisma>, replay))
        return replay
      }
      const winner = await prisma.decisionRecord.findFirst({ where: { revisionId: input.revisionId } })
      if (winner) {
        assertConcurrentWinnerIdentity(winner, expectedIdentity)
        return winner
      }
    }
    throw error
  }
}
