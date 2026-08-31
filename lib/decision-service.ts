import getPrisma from "@/lib/db"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"

export type DecisionActor = { kind: "SERVICE" } | { kind: "USER"; userId: string }

export class DecisionError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = "DecisionError"
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
  const prisma = getPrisma()
  const replay = await prisma.decisionRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
  if (replay) return replay

  const revision = await prisma.reviewRevision.findUnique({
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
    prisma.workspaceMember.findFirst({
      where: { workspaceId: revision.request.workspaceId, userId: input.actor.userId },
      select: { role: true },
    }),
    prisma.organizationMember.findFirst({
      where: { userId: input.actor.userId, organization: { workspaces: { some: { id: revision.request.workspaceId } } } },
      select: { role: true },
    }),
  ])
  const actorRole = isOrgAdminRole(orgMember?.role) ? "ADMIN" : normalizeWorkspaceRole(workspaceMember?.role)
  if (!workspaceMember && !orgMember) throw new DecisionError("ACCESS_DENIED", "Workspace not found or access denied.")
  if (revision.requiredRole === "ADMIN" && actorRole !== "ADMIN") {
    throw new DecisionError("ADMIN_REQUIRED", "Workspace admin approval is required.")
  }

  const terminal = await prisma.decisionRecord.findFirst({ where: { revisionId: revision.id } })
  if (terminal) throw new DecisionError("ALREADY_DECIDED", "A terminal decision already exists for this revision.")

  try {
    const decision = await prisma.decisionRecord.create({
      data: {
        workspaceId: revision.request.workspaceId,
        requestId: revision.requestId,
        revisionId: revision.id,
        optionId: option.id,
        fingerprint: revision.fingerprint,
        actorUserId: input.actor.userId,
        actorRole,
        rationale: input.rationale?.trim() || null,
        idempotencyKey: input.idempotencyKey,
      },
    })
    await prisma.reviewRequest.update({ where: { id: revision.requestId }, data: { state: "DECIDED", updatedAt: new Date() } })
    return decision
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const winner = await prisma.decisionRecord.findFirst({ where: { revisionId: revision.id } })
      if (winner) return winner
    }
    throw error
  }
}
