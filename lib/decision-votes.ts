/**
 * Advisory votes on tracked Decisions (ADR-0030).
 *
 * Votes are advisory: nothing here reads or writes the approval path. Casting a vote never changes ReviewRequest.state, never creates a
 * DecisionRecord and never calls lib/decision-service.ts; the recorded human decision stays the outcome.
 *
 * Trust model: every read and write takes the workspace of the CALLER (the doc workspace, resolved by the server action) and puts it in the
 * WHERE clause, so a request id from another workspace is indistinguishable from a missing one. The option is validated against the options
 * frozen in the current revision packet; the client only names an index and a label.
 *
 * Anonymity until decided: while the request is not DECIDED, a tally carries counts and the own vote of the caller only. Voters are listed
 * (by display name, never by email) once it is DECIDED. Votes are stored with the voter id (one vote per person), so this is anonymity toward
 * readers and API clients, not toward database administrators.
 */
import getPrisma, { type AppTransactionClient } from "@/lib/db"
import { withConflictRetry } from "@/lib/transaction-conflict"
import { excludeToolApprovals } from "@/lib/tool-approval/gate"
import { isUuid } from "@/lib/canvas-cards"
import { parsePacketQuestions } from "@/lib/tracked-decision-types"

/** States in which a request accepts votes. Every other state is read-only. */
export const VOTABLE_STATE = "PENDING"
/** The stored column width of chosen_option. */
export const MAX_VOTE_OPTION_LENGTH = 120
const MAX_VOTER_NAMES_PER_OPTION = 50

export type VoteQuestion = { question: string; options: string[] }

export type DecisionTallyOption = {
  label: string
  count: number
  /** Display names, only once the request is DECIDED. Absent while votes are anonymous. */
  voters?: string[]
  remainingVoters?: number
}
export type DecisionTallyQuestion = { question: string; options: DecisionTallyOption[]; myVote: string | null }
export type DecisionTally = {
  revisionId: string
  state: string
  /** True while the request still accepts votes. The viewer may additionally need to be allowed to vote (the caller decides that). */
  open: boolean
  questions: DecisionTallyQuestion[]
}

export class DecisionVoteError extends Error {
  constructor(public readonly code: "NOT_FOUND" | "CLOSED" | "INVALID_QUESTION" | "INVALID_OPTION" | "STALE_REVISION", message: string) {
    super(message)
    this.name = "DecisionVoteError"
  }
}

/**
 * The questions a packet asks, with the option labels that can be voted for. A multi-question packet carries them in the questions array; a
 * single-question packet carries a question and its options. A packet that offers no choices (Approve, Request changes, Reject only) is
 * not votable and returns an empty list.
 */
export function voteQuestionsOf(packetJson: string | null | undefined): VoteQuestion[] {
  const multi = parsePacketQuestions(packetJson)
  if (multi.length > 0) {
    return multi.map((q) => ({ question: q.question, options: labelsOf(q.options) }))
  }
  if (!packetJson) return []
  try {
    const packet = JSON.parse(packetJson) as { question?: unknown; options?: unknown }
    if (typeof packet.question !== "string") return []
    const options = labelsOf(packet.options)
    return options.length >= 2 ? [{ question: packet.question, options }] : []
  } catch {
    return []
  }
}

function labelsOf(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  const labels: string[] = []
  for (const option of options) {
    const label = (option as { label?: unknown } | null)?.label
    if (typeof label === "string" && label.length > 0) labels.push(label)
  }
  return labels
}

async function loadRequest(workspaceId: string, requestId: string) {
  if (!isUuid(workspaceId) || !isUuid(requestId)) return null
  return getPrisma().reviewRequest.findFirst({
    where: { id: requestId.toLowerCase(), workspaceId, ...excludeToolApprovals },
    select: { id: true, state: true, currentRevisionId: true, currentRevision: { select: { id: true, packetJson: true } } },
  })
}

/**
 * The tally for one request, or null when it is missing, foreign or offers no choices. The viewer id only decides which vote is marked
 * as the own vote of the caller.
 */
export async function getDecisionTally(input: { workspaceId: string; requestId: string; viewerUserId: string }): Promise<DecisionTally | null> {
  const request = await loadRequest(input.workspaceId, input.requestId)
  if (!request?.currentRevision) return null
  const questions = voteQuestionsOf(request.currentRevision.packetJson)
  if (questions.length === 0) return null
  const db = getPrisma()
  const decided = request.state === "DECIDED"
  const where = { workspaceId: input.workspaceId, requestId: request.id, revisionId: request.currentRevision.id }
  const missingVoteTable = Symbol("missing vote table")
  async function voteQuery<T>(query: () => Promise<T>): Promise<T> {
    try { return await query() } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2021") throw missingVoteTable
      throw error
    }
  }
  let result: DecisionTallyQuestion[]
  try {
    const mine = isUuid(input.viewerUserId) ? await voteQuery(() => db.decisionVote.findMany({ where: { ...where, voterUserId: input.viewerUserId }, select: { questionIndex: true, chosenOption: true } })) : []
    const counts = await voteQuery(() => db.decisionVote.groupBy({ by: ["questionIndex", "chosenOption"], where, _count: { _all: true } }))
    result = await Promise.all(questions.map(async (q, questionIndex) => ({
      question: q.question,
      myVote: q.options.includes(mine.find((v) => v.questionIndex === questionIndex)?.chosenOption ?? "") ? mine.find((v) => v.questionIndex === questionIndex)!.chosenOption : null,
      options: await Promise.all(q.options.map(async (label) => {
        const optionWhere = { ...where, questionIndex, chosenOption: label }
        const count = counts.find((row) => row.questionIndex === questionIndex && row.chosenOption === label)?._count._all ?? 0
        const option: DecisionTallyOption = { label, count }
        if (decided) {
          const votes = await voteQuery(() => db.decisionVote.findMany({ where: optionWhere, take: MAX_VOTER_NAMES_PER_OPTION, orderBy: { id: "asc" }, select: { voterUserId: true } }))
          const users = await db.user.findMany({ where: { id: { in: votes.map((v) => v.voterUserId) } }, select: { id: true, name: true } })
          const names = new Map(users.map((u) => [u.id, u.name?.trim() || "Member"]))
          option.voters = votes.map((v) => names.get(v.voterUserId) ?? "Member")
          option.remainingVoters = count - votes.length
        }
        return option
      })),
    })))
  } catch (error) {
    if (error === missingVoteTable) return null
    throw error
  }
  return {
    revisionId: request.currentRevision.id,
    state: request.state,
    open: request.state === VOTABLE_STATE,
    questions: result,
  }
}

/** Serialize vote mutations with changes to the request without changing its visible fields. */
async function mutateCurrentVote(
  input: { workspaceId: string; requestId: string; revisionId: string },
  write: (tx: Pick<AppTransactionClient, "decisionVote">) => Promise<unknown>,
): Promise<void> {
  const db = getPrisma()
  await withConflictRetry(() => db.$transaction(async (tx) => {
    // The guarded write makes Postgres lock the request and gives DSQL a shared
    // write-conflict target. A read alone would not fence a concurrent revision.
    const guard = await tx.reviewRequest.updateMany({
      where: {
        id: input.requestId, workspaceId: input.workspaceId, state: VOTABLE_STATE,
        currentRevisionId: input.revisionId, ...excludeToolApprovals,
      },
      data: { currentRevisionId: input.revisionId, updatedAt: undefined },
    })
    if (guard.count !== 1) {
      const current = await tx.reviewRequest.findFirst({
        where: { id: input.requestId, workspaceId: input.workspaceId, ...excludeToolApprovals },
        select: { currentRevisionId: true },
      })
      if (!current) throw new DecisionVoteError("NOT_FOUND", "Decision not found.")
      if (current.currentRevisionId !== input.revisionId) {
        throw new DecisionVoteError("STALE_REVISION", "This decision has changed. Refresh the card before voting.")
      }
      throw new DecisionVoteError("CLOSED", "Voting is closed for this decision.")
    }
    await write(tx)
  }))
}

/**
 * Cast or change the vote of the caller on one question. The caller must already have been authorized to vote in the workspace (a direct
 * workspace member); this function re-checks that the request belongs to that workspace, is still open, and that the option is one the
 * current revision offers. Replaces any earlier vote by the same person on the same question and revision.
 */
export async function castDecisionVote(input: { workspaceId: string; requestId: string; voterUserId: string; questionIndex: number; option: string; revisionId: string }): Promise<void> {
  const request = await loadRequest(input.workspaceId, input.requestId)
  if (!request?.currentRevision) throw new DecisionVoteError("NOT_FOUND", "Decision not found.")
  if (input.revisionId !== request.currentRevision.id) throw new DecisionVoteError("STALE_REVISION", "This decision has changed. Refresh the card before voting.")
  if (request.state !== VOTABLE_STATE) throw new DecisionVoteError("CLOSED", "Voting is closed for this decision.")
  const questions = voteQuestionsOf(request.currentRevision.packetJson)
  if (!Number.isInteger(input.questionIndex) || input.questionIndex < 0 || input.questionIndex >= questions.length) {
    throw new DecisionVoteError("INVALID_QUESTION", "That question is not part of this decision.")
  }
  if (typeof input.option !== "string" || input.option.length > MAX_VOTE_OPTION_LENGTH || !questions[input.questionIndex].options.includes(input.option)) {
    throw new DecisionVoteError("INVALID_OPTION", "That option is not offered by this decision.")
  }
  const now = new Date()
  await mutateCurrentVote({ ...input, requestId: request.id }, tx => tx.decisionVote.upsert({
    where: {
      requestId_revisionId_questionIndex_voterUserId: {
        requestId: request.id,
        revisionId: request.currentRevision.id,
        questionIndex: input.questionIndex,
        voterUserId: input.voterUserId,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      requestId: request.id,
      revisionId: request.currentRevision.id,
      questionIndex: input.questionIndex,
      chosenOption: input.option,
      voterUserId: input.voterUserId,
      createdAt: now,
      updatedAt: now,
    },
    update: { chosenOption: input.option, updatedAt: now },
  }))
}

/** Remove the vote of the caller on one question. Idempotent. A closed request refuses, so a tally cannot be altered after the outcome. */
export async function retractDecisionVote(input: { workspaceId: string; requestId: string; voterUserId: string; questionIndex: number; revisionId: string }): Promise<void> {
  const request = await loadRequest(input.workspaceId, input.requestId)
  if (!request?.currentRevision) throw new DecisionVoteError("NOT_FOUND", "Decision not found.")
  if (input.revisionId !== request.currentRevision.id) throw new DecisionVoteError("STALE_REVISION", "This decision has changed. Refresh the card before voting.")
  if (request.state !== VOTABLE_STATE) throw new DecisionVoteError("CLOSED", "Voting is closed for this decision.")
  if (!Number.isInteger(input.questionIndex) || input.questionIndex < 0) throw new DecisionVoteError("INVALID_QUESTION", "That question is not part of this decision.")
  await mutateCurrentVote({ ...input, requestId: request.id }, tx => tx.decisionVote.deleteMany({
    where: { workspaceId: input.workspaceId, requestId: request.id, revisionId: request.currentRevision.id, questionIndex: input.questionIndex, voterUserId: input.voterUserId },
  }))
}
