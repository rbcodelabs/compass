import getPrisma from "@/lib/db"
import { workspaceUpdatesAvailable, recordWorkspaceUpdate, retryUpdatesTransaction } from "@/lib/workspace-updates-capture"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"
import { isSubmitAnswersActionKey, parseDecisionAnswers, parsePacketQuestions, type TrackedDecisionAnswer, type TrackedDecisionAnswerInput } from "@/lib/tracked-decision-types"

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
  /** Canonical per-question answers ("[]" when none), so a replay with different answers conflicts. */
  answersKey: string
}

/** Order-independent identity of a set of answers; "[]" for none, matching a NULL answers_json. */
function answersKeyOf(answers: Array<{ questionIndex: number; chosenOption: string }> | undefined): string {
  return JSON.stringify([...(answers ?? [])].map((answer) => [answer.questionIndex, answer.chosenOption]).sort((a, b) => Number(a[0]) - Number(b[0])))
}

/**
 * Validates submitted answers against the questions frozen in the revision's
 * packet: every question answered exactly once, with one of its own option
 * labels. Returns the snapshot persisted on the decision record.
 */
function resolveAnswers(packetJson: string, submitted: TrackedDecisionAnswerInput[] | undefined): TrackedDecisionAnswer[] {
  const questions = parsePacketQuestions(packetJson)
  const answers = submitted ?? []
  const byIndex = new Map<number, string>()
  for (const answer of answers) {
    if (!Number.isInteger(answer.questionIndex) || answer.questionIndex < 0 || answer.questionIndex >= questions.length) throw new DecisionError("ANSWER_INVALID", "An answer refers to a question that is not part of this request.")
    if (byIndex.has(answer.questionIndex)) throw new DecisionError("ANSWER_INVALID", "Each question can be answered only once.")
    byIndex.set(answer.questionIndex, answer.chosenOption)
  }
  return questions.map((question, index) => {
    const chosen = byIndex.get(index)
    if (chosen === undefined) throw new DecisionError("ANSWERS_INCOMPLETE", "Answer every question before submitting.")
    if (!question.options.some((option) => option.label === chosen)) throw new DecisionError("ANSWER_INVALID", `"${chosen}" is not an option of question ${index + 1}.`)
    return { questionIndex: index, question: question.question, chosenOption: chosen }
  })
}

function assertIdempotentIdentity(existing: DecisionIdentity, expected: DecisionIdentity): void {
  if (
    existing.actorUserId !== expected.actorUserId ||
    existing.revisionId !== expected.revisionId ||
    existing.optionId !== expected.optionId ||
    existing.fingerprint !== expected.fingerprint ||
    existing.answersKey !== expected.answersKey
  ) {
    throw new DecisionError("IDEMPOTENCY_KEY_CONFLICT", "This idempotency key belongs to a different decision submission.")
  }
}

function assertConcurrentWinnerIdentity(winner: DecisionIdentity, expected: DecisionIdentity): void {
  if (
    winner.actorUserId !== expected.actorUserId ||
    winner.revisionId !== expected.revisionId ||
    winner.optionId !== expected.optionId ||
    winner.fingerprint !== expected.fingerprint ||
    winner.answersKey !== expected.answersKey
  ) {
    throw new DecisionError("ALREADY_DECIDED", "A different terminal decision won this revision.")
  }
}

function withAnswersKey<T extends { answersJson?: string | null }>(record: T): T & { answersKey: string } {
  return { ...record, answersKey: answersKeyOf(parseDecisionAnswers(record.answersJson)) }
}

async function repairRequestStateIfRevisionIsCurrent(tx: ReturnType<typeof getPrisma>, replay: { requestId: string; revisionId: string }): Promise<void> {
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
  /** Per-question answers; required (one per question) when the option is Submit answers, rejected otherwise. */
  answers?: TrackedDecisionAnswerInput[]
  idempotencyKey: string
}) {
  if (input.actor.kind !== "USER") {
    throw new DecisionError("HUMAN_ACTOR_REQUIRED", "An authenticated human must take this decision.")
  }
  const actorUserId = input.actor.userId
  const prisma = getPrisma()
  const capture = await workspaceUpdatesAvailable(prisma)
  const expectedIdentity = { actorUserId, revisionId: input.revisionId, optionId: input.optionId, fingerprint: input.fingerprint, answersKey: answersKeyOf(input.answers) }
  try {
    return await retryUpdatesTransaction(prisma, async (tx) => {
      const replay = await tx.decisionRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (replay) {
        assertIdempotentIdentity(withAnswersKey(replay), expectedIdentity)
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
      if (
        revision.request.gateType === "TRACKED_DECISION" &&
        (option.outcomeClass === "REJECT" || option.outcomeClass === "REQUEST_CHANGES") &&
        !input.rationale?.trim()
      ) {
        throw new DecisionError("RATIONALE_REQUIRED", "Add a rationale before rejecting or requesting changes.")
      }

      // Answers ride only on the Submit answers option; Request changes / Reject
      // apply to the whole request and need none. Validated before any write.
      const submitsAnswers = revision.request.gateType === "TRACKED_DECISION" && isSubmitAnswersActionKey(option.actionKey)
      if (!submitsAnswers && input.answers?.length) throw new DecisionError("ANSWERS_NOT_ALLOWED", "Answers can only be submitted with Submit answers.")
      const answers = submitsAnswers ? resolveAnswers(revision.packetJson, input.answers) : undefined

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
          rationale: input.rationale?.trim() || null, ...(answers ? { answersJson: JSON.stringify(answers) } : {}), idempotencyKey: input.idempotencyKey,
        },
      })
      await tx.reviewRequest.update({ where: { id: revision.requestId }, data: { state: "DECIDED", updatedAt: new Date() } })
      if (capture) await recordWorkspaceUpdate(tx, { workspaceId: revision.request.workspaceId, entityType: "DECISION", entityId: revision.requestId, kind: "DECISION_RECORDED", actorType: "USER", actorId: actorUserId })
      return decision
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      const replay = await prisma.decisionRecord.findUnique({ where: { idempotencyKey: input.idempotencyKey } })
      if (replay) {
        assertIdempotentIdentity(withAnswersKey(replay), expectedIdentity)
        await prisma.$transaction((tx) => repairRequestStateIfRevisionIsCurrent(tx as ReturnType<typeof getPrisma>, replay))
        return replay
      }
      const winner = await prisma.decisionRecord.findFirst({ where: { revisionId: input.revisionId } })
      if (winner) {
        assertConcurrentWinnerIdentity(withAnswersKey(winner), expectedIdentity)
        return winner
      }
    }
    throw error
  }
}
