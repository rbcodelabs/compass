import getPrisma from "@/lib/db"
import type { AppPrismaClient } from "@/lib/db"
import { loadCustomFieldDefinitions } from "@/lib/custom-field-definitions"
import { resolveEffectiveOptions } from "@/lib/shared-field-options"
import type { CustomFieldObjectType, SelectOption } from "@/lib/types"
import {
  computeNetFlow,
  rankContested,
  tallyByObject,
  type NetFlow,
  type ObjectTally,
  type TallyObject,
  type TallyProposal,
} from "@/lib/card-sort-tally"

/**
 * Card sorting: propose moves on any SELECT custom field, then tally them.
 *
 * The "factor" is a CustomFieldDefinition of type SELECT; its effective options
 * are the buckets. Effective options are always resolved through
 * lib/shared-field-options.ts so a factor backed by a SharedFieldOptionSet
 * (migration 053) behaves identically to one with local options — that is the
 * whole reason a Priority round and a Quarter round need no different code.
 *
 * Nothing in this file names a specific field or option value. If you find
 * yourself adding a branch on a field name, the feature has stopped being
 * generic and the three-factor acceptance test will catch it.
 *
 * Tally math lives in lib/card-sort-tally.ts, including the sparse-delta
 * invariant that absence of a proposal is never agreement.
 */

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * A single error type with a machine-readable code, because this module has two
 * callers with different output conventions: MCP handlers, which turn failures
 * into `fail()` text, and HTTP routes, which need a status. Returning ok/fail
 * shapes from here would force the HTTP layer to parse prose.
 */
export type CardSortErrorCode =
  | "NOT_FOUND"
  | "INVALID_FACTOR"
  | "INVALID_VALUE"
  | "NO_OP"
  | "WRONG_STATE"
  | "HIDDEN_UNTIL_REVEALED"
  | "FORBIDDEN"

export class CardSortError extends Error {
  constructor(
    readonly code: CardSortErrorCode,
    message: string
  ) {
    super(message)
    this.name = "CardSortError"
  }
}

/** HTTP status for each failure mode, so routes do not each invent a mapping. */
export const CARD_SORT_ERROR_STATUS: Record<CardSortErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_FACTOR: 400,
  INVALID_VALUE: 400,
  NO_OP: 400,
  WRONG_STATE: 409,
  // 403 rather than 404: the round's existence is not the secret, its contents
  // are. A participant in an OPEN round knows perfectly well it exists.
  HIDDEN_UNTIL_REVEALED: 403,
  FORBIDDEN: 403,
}

// ── Round state ─────────────────────────────────────────────────────────────

export const CARD_SORT_ROUND_STATES = ["OPEN", "REVEALED", "CLOSED"] as const
export type CardSortRoundState = (typeof CARD_SORT_ROUND_STATES)[number]

export function isCardSortRoundState(value: string): value is CardSortRoundState {
  return (CARD_SORT_ROUND_STATES as readonly string[]).includes(value)
}

/**
 * Who is allowed to see other people's proposals, counts and targets.
 *
 * This is the blind-vote guarantee in one function. It is pure and exported so
 * it can be unit-tested directly, but it is never the only line of defence —
 * every read path that returns other people's data calls
 * `assertCanSeeOtherProposals` below, so an endpoint cannot accidentally omit
 * the check by forgetting to render something.
 *
 * "Facilitator" is the round's creator, and deliberately *not* workspace
 * admins. Widening it to admins would mean anyone with an admin role could
 * silently read a round they are participating in, which breaks the guarantee
 * for exactly the people most likely to be in the room.
 */
export function canSeeOtherProposals(
  round: { state: string; createdById: string },
  userId: string
): boolean {
  if (round.state === "OPEN") return round.createdById === userId
  return true
}

export function assertCanSeeOtherProposals(
  round: { id: string; state: string; createdById: string },
  userId: string
): void {
  if (!canSeeOtherProposals(round, userId)) {
    throw new CardSortError(
      "HIDDEN_UNTIL_REVEALED",
      "This round is still OPEN, so proposals are visible only to the person who created it. Reveal the round to see everyone's proposals and the tally."
    )
  }
}

// ── Objects under sort ──────────────────────────────────────────────────────

/**
 * Per-object-type listing. Opportunity, Solution, Experiment, Objective,
 * RoadmapItem and Task carry workspaceId directly; only Key Result is reached
 * through its Objective's workspaceId. These are the same columns
 * lib/mcp-authz.ts resolves for authorization, kept consistent with it on
 * purpose so a card sort can never see a wider set of objects than the authz
 * layer believes belongs to the workspace. A Solution or Objective whose own
 * workspaceId is NULL (not yet backfilled) or names another workspace is
 * therefore absent from these lists, and a proposal naming it is NOT_FOUND.
 */
const OBJECT_LOADERS: Record<
  CustomFieldObjectType,
  (prisma: AppPrismaClient, workspaceId: string) => Promise<{ id: string; title: string }[]>
> = {
  OPPORTUNITY: (p, workspaceId) =>
    p.opportunity.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
  SOLUTION: (p, workspaceId) =>
    p.solution.findMany({
      where: { workspaceId },
      select: { id: true, title: true },
    }),
  EXPERIMENT: (p, workspaceId) =>
    p.experiment.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
  OBJECTIVE: (p, workspaceId) =>
    p.objective.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
  KEY_RESULT: (p, workspaceId) =>
    p.keyResult.findMany({
      where: { objective: { workspaceId } },
      select: { id: true, title: true },
    }),
  ROADMAP_ITEM: (p, workspaceId) =>
    p.roadmapItem.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
  TASK: (p, workspaceId) =>
    p.task.findMany({ where: { workspaceId }, select: { id: true, title: true } }),
}

export function isCardSortObjectType(value: string): value is CustomFieldObjectType {
  return Object.prototype.hasOwnProperty.call(OBJECT_LOADERS, value)
}

// ── Factors ─────────────────────────────────────────────────────────────────

export type CardSortFactor = {
  id: string
  name: string
  objectType: CustomFieldObjectType
  options: SelectOption[]
  /** Name of the shared option set backing this factor, when there is one. */
  sharedOptionSetName: string | null
}

/**
 * Every field that can serve as a factor for an object type.
 *
 * SELECT only, not MULTI_SELECT: a card sort puts each object in exactly one
 * bucket, and "propose moving this to X" has no clear meaning when an object
 * legitimately holds three values at once. Supporting MULTI_SELECT would need
 * its own add/remove semantics rather than a move.
 */
export async function listCardSortFactors({
  workspaceId,
  objectType,
}: {
  workspaceId: string
  objectType: CustomFieldObjectType
}): Promise<CardSortFactor[]> {
  const definitions = await loadCustomFieldDefinitions(getPrisma(), {
    workspaceId,
    objectTypes: [objectType],
  })
  return definitions
    .filter((field) => field.fieldType === "SELECT" && (field.options?.length ?? 0) > 0)
    .map((field) => ({
      id: field.id,
      name: field.name,
      objectType: field.objectType,
      options: field.options ?? [],
      sharedOptionSetName: field.sharedOptionSetName,
    }))
}

/**
 * Loads a factor and its effective options, rejecting anything unusable as a
 * card sort factor. Every write and read path funnels through this rather than
 * reading CustomFieldDefinition directly, so the cross-tenant and field-type
 * checks cannot be skipped by one caller.
 */
export async function loadFactor(
  prisma: AppPrismaClient,
  { workspaceId, fieldDefinitionId }: { workspaceId: string; fieldDefinitionId: string }
): Promise<{ id: string; name: string; objectType: CustomFieldObjectType; options: SelectOption[] }> {
  const field = await prisma.customFieldDefinition.findUnique({
    where: { id: fieldDefinitionId },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  if (!field) {
    throw new CardSortError("NOT_FOUND", `Custom field definition not found: ${fieldDefinitionId}`)
  }
  // Mirrors setCustomFieldValue's guard: a field id from another workspace must
  // never be usable here just because the caller is a member of some workspace.
  if (field.workspaceId !== workspaceId) {
    throw new CardSortError(
      "NOT_FOUND",
      `Custom field definition not found in this workspace: ${fieldDefinitionId}`
    )
  }
  if (field.fieldType !== "SELECT") {
    throw new CardSortError(
      "INVALID_FACTOR",
      `Field "${field.name}" is ${field.fieldType}, but a card sort factor must be SELECT — the sort needs a fixed set of buckets to move objects between.`
    )
  }
  const options = resolveEffectiveOptions(field)
  if (options.length === 0) {
    throw new CardSortError(
      "INVALID_FACTOR",
      `Field "${field.name}" has no options, so there is nothing to sort into.`
    )
  }
  if (!isCardSortObjectType(field.objectType)) {
    throw new CardSortError(
      "INVALID_FACTOR",
      `Field "${field.name}" has unrecognized objectType ${field.objectType}.`
    )
  }
  return { id: field.id, name: field.name, objectType: field.objectType, options }
}

// ── Rounds ──────────────────────────────────────────────────────────────────

export type CardSortRoundSummary = {
  id: string
  name: string
  objectType: CustomFieldObjectType
  fieldDefinitionId: string
  factorName: string
  state: CardSortRoundState
  createdById: string
  createdAt: Date
  revealedAt: Date | null
  closedAt: Date | null
  /**
   * Total proposals in the round, or null when the caller is not allowed to know
   * it yet — a participant on an OPEN round.
   *
   * Null rather than 0 deliberately. Zero is a real, readable answer ("nobody has
   * proposed anything"), and handing that to someone who is merely not permitted
   * to see the number would be a lie that happens to be indistinguishable from
   * the truth. Null forces every caller to render "hidden" rather than silently
   * printing a false zero.
   */
  proposalCount: number | null
  /** The caller's own proposal count, always visible to them. */
  myProposalCount: number
}

/**
 * Redacts the round-wide proposal count for a caller who may not see it yet.
 *
 * A bare count looks harmless, and an earlier version of this module exposed it
 * on that reasoning. It is not harmless: "31 proposals across 22 objects" tells a
 * participant the round is heavily contested before they have formed their own
 * view, and "0 proposals" tells them they are first and can anchor everyone else.
 * Both are exactly the influence hiding-until-revealed exists to prevent, so the
 * count travels under the same gate as the proposals themselves.
 */
function visibleProposalCount(
  round: { state: string; createdById: string },
  userId: string,
  total: number
): number | null {
  return canSeeOtherProposals(round, userId) ? total : null
}

export async function createCardSortRound({
  workspaceId,
  name,
  fieldDefinitionId,
  userId,
}: {
  workspaceId: string
  name: string
  fieldDefinitionId: string
  userId: string
}): Promise<CardSortRoundSummary> {
  const prisma = getPrisma()
  const factor = await loadFactor(prisma, { workspaceId, fieldDefinitionId })
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    throw new CardSortError("INVALID_VALUE", "Round name is required.")
  }
  // objectType is copied from the factor rather than accepted from the caller.
  // Two sources for the same fact would eventually disagree, and the factor is
  // the authoritative one.
  const round = await prisma.cardSortRound.create({
    data: {
      workspaceId,
      name: trimmed,
      objectType: factor.objectType,
      fieldDefinitionId,
      state: "OPEN",
      createdById: userId,
    },
  })
  // Returned as a CardSortRoundSummary rather than the raw row so that every
  // caller sees the same shape `listCardSortRounds` gives them — including
  // factorName, which the row does not carry. A brand new round has no
  // proposals, and its creator is its facilitator, so the count is a real 0
  // rather than a redacted null.
  return {
    id: round.id,
    name: round.name,
    objectType: round.objectType as CustomFieldObjectType,
    fieldDefinitionId: round.fieldDefinitionId,
    factorName: factor.name,
    state: round.state as CardSortRoundState,
    createdById: round.createdById,
    createdAt: round.createdAt,
    revealedAt: round.revealedAt,
    closedAt: round.closedAt,
    proposalCount: 0,
    myProposalCount: 0,
  }
}

export async function listCardSortRounds({
  workspaceId,
  userId,
  state,
}: {
  workspaceId: string
  userId: string
  state?: CardSortRoundState
}): Promise<CardSortRoundSummary[]> {
  const prisma = getPrisma()
  const rounds = await prisma.cardSortRound.findMany({
    where: { workspaceId, ...(state ? { state } : {}) },
    include: {
      fieldDefinition: { select: { name: true } },
      // Fetched for everyone but returned only to callers who may see it — see
      // visibleProposalCount. A participant on an OPEN round gets null, and
      // learns a round needs their attention from its state and their own count
      // instead.
      _count: { select: { proposals: true } },
    },
    orderBy: { createdAt: "desc" },
  })
  // Tallied in JS from a plain projection rather than with prisma.groupBy.
  // groupBy has no other caller anywhere in this codebase, so its emitted SQL
  // has never run against Aurora DSQL; the rest of this page's query shapes are
  // exercised daily by /discovery. One row per proposal is cheap here because a
  // round holds at most one proposal per person per item, and we only ever read
  // the current user's.
  const myProposals = rounds.length
    ? await prisma.cardSortProposal.findMany({
        where: { roundId: { in: rounds.map((r) => r.id) }, userId },
        select: { roundId: true },
      })
    : []
  const mine = new Map<string, number>()
  for (const proposal of myProposals) {
    mine.set(proposal.roundId, (mine.get(proposal.roundId) ?? 0) + 1)
  }

  return rounds.map((round) => ({
    id: round.id,
    name: round.name,
    objectType: round.objectType as CustomFieldObjectType,
    fieldDefinitionId: round.fieldDefinitionId,
    factorName: round.fieldDefinition.name,
    state: round.state as CardSortRoundState,
    createdById: round.createdById,
    createdAt: round.createdAt,
    revealedAt: round.revealedAt,
    closedAt: round.closedAt,
    proposalCount: visibleProposalCount(round, userId, round._count.proposals),
    myProposalCount: mine.get(round.id) ?? 0,
  }))
}

export async function loadRound(prisma: AppPrismaClient, roundId: string, workspaceId?: string) {
  const round = await prisma.cardSortRound.findUnique({
    where: { id: roundId },
    include: { fieldDefinition: { select: { name: true } } },
  })
  if (!round || (workspaceId !== undefined && round.workspaceId !== workspaceId)) {
    throw new CardSortError("NOT_FOUND", `Card sort round not found: ${roundId}`)
  }
  return round
}

/**
 * Reveal or close a round.
 *
 * Only the facilitator may do this. Revealing is irreversible by design: once
 * the room has seen the tally, "un-revealing" would restore no secrecy, so
 * offering it would be a lie about what the state means. A new round is the
 * honest way to run a second blind pass.
 */
export async function setCardSortRoundState({
  workspaceId,
  roundId,
  userId,
  state,
}: {
  workspaceId: string
  roundId: string
  userId: string
  state: Extract<CardSortRoundState, "REVEALED" | "CLOSED">
}) {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  if (round.createdById !== userId) {
    throw new CardSortError(
      "FORBIDDEN",
      "Only the person who created this round can reveal or close it."
    )
  }
  if (round.state === "CLOSED") {
    throw new CardSortError("WRONG_STATE", "This round is already closed.")
  }
  if (state === "REVEALED" && round.state === "REVEALED") {
    throw new CardSortError("WRONG_STATE", "This round is already revealed.")
  }
  return prisma.cardSortRound.update({
    where: { id: roundId },
    data: {
      state,
      ...(state === "REVEALED" ? { revealedAt: new Date() } : { closedAt: new Date() }),
    },
  })
}

// ── Proposals ───────────────────────────────────────────────────────────────

/**
 * Record one person's proposed move, or update it if they already had one.
 *
 * Three rules are enforced here and nowhere else, so every caller gets them:
 *
 *  1. `proposedValue` must be one of the factor's *effective* options. A value
 *     that is valid for some other field, or an option that was removed from a
 *     shared set, is rejected.
 *  2. `fromValue` is read from the live CustomFieldValue by the server. It is
 *     never taken from the caller — a client-supplied snapshot could claim the
 *     object started anywhere, which would corrupt net flow while leaving the
 *     per-object counts looking perfectly sane.
 *  3. A proposal equal to the current official value is rejected. Somebody
 *     clicking the bucket an object is already in has expressed no opinion, and
 *     storing it would put a phantom self-loop in the flow graph.
 */
export async function proposeCardSortMove({
  workspaceId,
  roundId,
  userId,
  objectId,
  proposedValue,
  rationale,
}: {
  workspaceId: string
  roundId: string
  userId: string
  objectId: string
  proposedValue: string
  rationale?: string | null
}) {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  if (round.state !== "OPEN") {
    throw new CardSortError(
      "WRONG_STATE",
      `This round is ${round.state}. Proposals can only be made while a round is OPEN.`
    )
  }
  const factor = await loadFactor(prisma, {
    workspaceId,
    fieldDefinitionId: round.fieldDefinitionId,
  })
  if (!factor.options.some((option) => option.value === proposedValue)) {
    throw new CardSortError(
      "INVALID_VALUE",
      `"${proposedValue}" is not an option on ${factor.name}. Valid options: ${factor.options
        .map((option) => option.value)
        .join(", ")}`
    )
  }

  const objectType = round.objectType as CustomFieldObjectType
  const objects = await OBJECT_LOADERS[objectType](prisma, workspaceId)
  if (!objects.some((object) => object.id === objectId)) {
    // relationMode="prisma" means no FK would have caught this. Without the
    // check, a proposal could reference an object in another workspace and
    // surface in this round's tally.
    throw new CardSortError(
      "NOT_FOUND",
      `${objectType} not found in this workspace: ${objectId}`
    )
  }

  const fromValue = await readOfficialValue(prisma, round.fieldDefinitionId, objectId)
  if (fromValue === proposedValue) {
    // Label, not raw value, and name the object.
    //
    // The stored value is a slug — `must_do_(contractually_obligated)` — while
    // the menu item the user just clicked read "Must Do (contractually
    // obligated)". Echoing the slug back makes the refusal look like it is
    // talking about some other bucket than the one they picked.
    //
    // Naming the object is what makes this message usable in the bulk path,
    // where several rows can be skipped at once and the UI lists the reasons:
    // "That object is already in…" repeated three times identifies nothing.
    const label =
      factor.options.find((option) => option.value === proposedValue)?.label ?? proposedValue
    const title = objects.find((object) => object.id === objectId)?.title
    throw new CardSortError(
      "NO_OP",
      `${title ? `“${title}” is` : "That object is"} already in "${label}". A proposal has to name a different bucket — agreeing with the current value is not recorded as a proposal.`
    )
  }

  return prisma.cardSortProposal.upsert({
    where: { roundId_userId_objectId: { roundId, userId, objectId } },
    create: {
      roundId,
      userId,
      objectId,
      proposedValue,
      fromValue,
      rationale: rationale?.trim() || null,
    },
    // Latest wins: changing your mind replaces your single proposal rather than
    // appending a second one. fromValue is re-snapshotted because the official
    // value may have moved since the first attempt.
    update: { proposedValue, fromValue, rationale: rationale?.trim() || null },
  })
}

export type BulkProposalResult = {
  applied: string[]
  skipped: { objectId: string; code: CardSortErrorCode; reason: string }[]
}

/**
 * Propose the same move for many objects at once.
 *
 * Partial success is the correct semantic here, not all-or-nothing. Selecting
 * twenty rows and sending them all to "Could Do" will almost always include a
 * few already in Could Do; aborting the whole batch over those would make bulk
 * propose useless exactly when it matters most. Each skip is reported with its
 * reason so the UI can say which rows did not move and why, rather than
 * silently dropping them.
 *
 * Sequential rather than parallel: every call re-reads the round and the factor,
 * and twenty concurrent upserts against the same unique index is a deadlock risk
 * for no meaningful latency win at the sizes this is used at.
 */
export async function proposeCardSortMoves({
  workspaceId,
  roundId,
  userId,
  objectIds,
  proposedValue,
  rationale,
}: {
  workspaceId: string
  roundId: string
  userId: string
  objectIds: string[]
  proposedValue: string
  rationale?: string | null
}): Promise<BulkProposalResult> {
  const applied: string[] = []
  const skipped: BulkProposalResult["skipped"] = []
  // One object means the caller pointed at one row and asked for one thing, so
  // anything that stops it is an error they need to see. Tolerating it would
  // return 200 for a gesture that did nothing. Two or more means multi-select,
  // where some rows sitting in the target bucket already is the normal case
  // rather than a mistake — see the comment in the catch below.
  const strict = objectIds.length === 1
  for (const objectId of objectIds) {
    try {
      await proposeCardSortMove({
        workspaceId,
        roundId,
        userId,
        objectId,
        proposedValue,
        rationale,
      })
      applied.push(objectId)
    } catch (error) {
      if (error instanceof CardSortError) {
        // A bad round or a bad target value is wrong for every object in the
        // batch, so reporting it per-row would bury one real problem under
        // twenty copies of itself. Fail the batch instead.
        if (strict || error.code === "WRONG_STATE" || error.code === "INVALID_VALUE") throw error
        skipped.push({ objectId, code: error.code, reason: error.message })
        continue
      }
      throw error
    }
  }
  return { applied, skipped }
}

/** Reads the official SELECT value for one object, or null when unset. */
async function readOfficialValue(
  prisma: AppPrismaClient,
  fieldId: string,
  objectId: string
): Promise<string | null> {
  const row = await prisma.customFieldValue.findUnique({
    where: { fieldId_objectId: { fieldId, objectId } },
    select: { value: true },
  })
  if (!row) return null
  return typeof row.value === "string" && row.value.length > 0 ? row.value : null
}

/**
 * Withdraws the caller's own proposal.
 *
 * Scoped to `userId` in the delete filter rather than checked after a lookup,
 * so there is no code path on which one participant can remove another's
 * proposal. Deleting returns the object to "no opinion recorded", which is
 * exactly right — it is not the same as proposing that it stay put.
 */
export async function withdrawCardSortProposal({
  workspaceId,
  roundId,
  userId,
  objectId,
}: {
  workspaceId: string
  roundId: string
  userId: string
  objectId: string
}) {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  if (round.state !== "OPEN") {
    throw new CardSortError(
      "WRONG_STATE",
      `This round is ${round.state}. Proposals can only be withdrawn while a round is OPEN.`
    )
  }
  const deleted = await prisma.cardSortProposal.deleteMany({
    where: { roundId, userId, objectId },
  })
  if (deleted.count === 0) {
    throw new CardSortError("NOT_FOUND", "You have no proposal on that object to withdraw.")
  }
  return { withdrawn: deleted.count }
}

export type MyProposal = {
  objectId: string
  objectTitle: string
  proposedValue: string
  fromValue: string | null
  rationale: string | null
  updatedAt: Date
}

/**
 * The caller's own proposals. Always permitted regardless of round state —
 * hiding your own ballot from you serves nothing.
 */
export async function listMyCardSortProposals({
  workspaceId,
  roundId,
  userId,
}: {
  workspaceId: string
  roundId: string
  userId: string
}): Promise<MyProposal[]> {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  const [proposals, objects] = await Promise.all([
    prisma.cardSortProposal.findMany({ where: { roundId, userId }, orderBy: { updatedAt: "desc" } }),
    OBJECT_LOADERS[round.objectType as CustomFieldObjectType](prisma, workspaceId),
  ])
  const titles = new Map(objects.map((object) => [object.id, object.title]))
  return proposals.map((proposal) => ({
    objectId: proposal.objectId,
    objectTitle: titles.get(proposal.objectId) ?? "(deleted object)",
    proposedValue: proposal.proposedValue,
    fromValue: proposal.fromValue,
    rationale: proposal.rationale,
    updatedAt: proposal.updatedAt,
  }))
}

// ── Board (the sort screen's data) ──────────────────────────────────────────

export type CardSortBoardRow = {
  objectId: string
  title: string
  currentValue: string | null
  /** The caller's own proposal for this object, if any. */
  myProposedValue: string | null
  myRationale: string | null
}

/**
 * One proposal the caller is allowed to see, for the kanban's "proposed in"
 * zones. Includes the proposer's display name because a ghost card showing "3
 * people" with no way to find out who is not actionable.
 */
export type CardSortBoardProposal = {
  objectId: string
  userId: string
  userName: string
  proposedValue: string
  fromValue: string | null
  rationale: string | null
  /** True when this is the caller's own proposal, so withdraw can be offered. */
  isMine: boolean
}

export type CardSortBoard = {
  round: CardSortRoundSummary
  factor: { id: string; name: string; options: SelectOption[] }
  rows: CardSortBoardRow[]
  /**
   * Proposals the caller may see. On an OPEN round this is the caller's own and
   * nothing else; once revealed it is everyone's. See the doc comment on
   * loadCardSortBoard for why this is a gate and not an omission.
   */
  proposals: CardSortBoardProposal[]
  isFacilitator: boolean
  canSeeTally: boolean
}

/**
 * Everything the sort screen renders: objects with their current bucket, plus
 * whichever proposals the caller is allowed to see.
 *
 * ── What "allowed to see" means here ────────────────────────────────────────
 *
 * The `proposals` array is filtered by `canSeeOtherProposals` — the same
 * function the tally uses, deliberately, so there is one definition of the
 * blind-vote rule rather than two that can drift:
 *
 *   OPEN      → the caller's own proposals only. For a participant that means a
 *               board whose "proposed in" columns look nearly empty. That is
 *               correct, not a bug: on a live round you are meant to see your own
 *               opinion and nobody else's.
 *   REVEALED  → everyone's.
 *   CLOSED    → everyone's, but no new or withdrawn proposals are accepted.
 *
 * This replaces an earlier, stronger promise — that other people's proposals
 * were never in this payload in any state — which the kanban's dual-zone columns
 * make untenable: a ghost card exists precisely to show that somebody wants an
 * object moved here, and on a revealed round that is the point of the screen.
 * The guarantee is now the gate rather than the absence of the data, so the thing
 * to protect is this function: filtering in the component instead would put the
 * blind-vote rule in the browser, where a participant can read past it.
 */
export async function loadCardSortBoard({
  workspaceId,
  roundId,
  userId,
}: {
  workspaceId: string
  roundId: string
  userId: string
}): Promise<CardSortBoard> {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  const objectType = round.objectType as CustomFieldObjectType
  const factor = await loadFactor(prisma, {
    workspaceId,
    fieldDefinitionId: round.fieldDefinitionId,
  })

  // The gate decides what is QUERIED, not just what is rendered. On an OPEN
  // round the other participants' proposals never leave the database, so no
  // serialization mistake downstream can leak them.
  const canSeeAll = canSeeOtherProposals(round, userId)

  const [objects, values, myProposals, totalCount, everyProposal] = await Promise.all([
    OBJECT_LOADERS[objectType](prisma, workspaceId),
    prisma.customFieldValue.findMany({
      where: { fieldId: round.fieldDefinitionId },
      select: { objectId: true, value: true },
    }),
    prisma.cardSortProposal.findMany({ where: { roundId, userId } }),
    prisma.cardSortProposal.count({ where: { roundId } }),
    canSeeAll ? prisma.cardSortProposal.findMany({ where: { roundId } }) : Promise.resolve(null),
  ])

  const visible = everyProposal ?? myProposals
  const proposerIds = [...new Set(visible.map((proposal) => proposal.userId))]
  const proposers = proposerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: proposerIds } },
        select: { id: true, name: true, email: true },
      })
    : []
  const userLabel = new Map(proposers.map((user) => [user.id, user.name || user.email || user.id]))

  const proposals: CardSortBoardProposal[] = visible.map((proposal) => ({
    objectId: proposal.objectId,
    userId: proposal.userId,
    userName: userLabel.get(proposal.userId) ?? proposal.userId,
    proposedValue: proposal.proposedValue,
    fromValue: proposal.fromValue,
    rationale: proposal.rationale,
    isMine: proposal.userId === userId,
  }))

  const currentByObject = new Map(
    values.map((row) => [
      row.objectId,
      typeof row.value === "string" && row.value.length > 0 ? row.value : null,
    ])
  )
  const mineByObject = new Map(myProposals.map((p) => [p.objectId, p]))
  const optionOrder = new Map(factor.options.map((option, index) => [option.value, index]))

  const rows: CardSortBoardRow[] = objects
    .map((object) => {
      const mine = mineByObject.get(object.id)
      return {
        objectId: object.id,
        title: object.title,
        currentValue: currentByObject.get(object.id) ?? null,
        myProposedValue: mine?.proposedValue ?? null,
        myRationale: mine?.rationale ?? null,
      }
    })
    // Grouped by current bucket in the field's own option order, then by title.
    // Option order rather than alphabetical because a MoSCoW field is ordered
    // by intent — Must before Should before Could — and alphabetising it would
    // destroy the only useful reading of the list.
    .sort(
      (a, b) =>
        (optionOrder.get(a.currentValue ?? "") ?? Number.MAX_SAFE_INTEGER) -
          (optionOrder.get(b.currentValue ?? "") ?? Number.MAX_SAFE_INTEGER) ||
        a.title.localeCompare(b.title)
    )

  return {
    round: {
      id: round.id,
      name: round.name,
      objectType,
      fieldDefinitionId: round.fieldDefinitionId,
      factorName: round.fieldDefinition.name,
      state: round.state as CardSortRoundState,
      createdById: round.createdById,
      createdAt: round.createdAt,
      revealedAt: round.revealedAt,
      closedAt: round.closedAt,
      proposalCount: visibleProposalCount(round, userId, totalCount),
      myProposalCount: myProposals.length,
    },
    factor: { id: factor.id, name: factor.name, options: factor.options },
    rows,
    proposals,
    isFacilitator: round.createdById === userId,
    canSeeTally: canSeeAll,
  }
}

// ── Tally ───────────────────────────────────────────────────────────────────

export type CardSortTally = {
  round: { id: string; name: string; state: CardSortRoundState; factorName: string }
  options: SelectOption[]
  objects: ObjectTally[]
  contested: ObjectTally[]
  flow: NetFlow
  /** Distinct people who recorded at least one proposal. */
  participantCount: number
  proposalCount: number
}

/**
 * The tally.
 *
 * `assertCanSeeOtherProposals` runs before any proposal is read, which is the
 * server-side half of hidden-until-revealed. This is not a UI concern: an
 * authenticated participant calling the tally endpoint directly on an OPEN
 * round gets HIDDEN_UNTIL_REVEALED, not a payload they were not meant to see.
 * __tests__/card-sort-visibility.test.ts asserts exactly that.
 */
export async function getCardSortTally({
  workspaceId,
  roundId,
  userId,
}: {
  workspaceId: string
  roundId: string
  userId: string
}): Promise<CardSortTally> {
  const prisma = getPrisma()
  const round = await loadRound(prisma, roundId, workspaceId)
  assertCanSeeOtherProposals(round, userId)

  const factor = await loadFactor(prisma, {
    workspaceId,
    fieldDefinitionId: round.fieldDefinitionId,
  })
  const objectType = round.objectType as CustomFieldObjectType

  const [objects, values, proposals] = await Promise.all([
    OBJECT_LOADERS[objectType](prisma, workspaceId),
    prisma.customFieldValue.findMany({
      where: { fieldId: round.fieldDefinitionId },
      select: { objectId: true, value: true },
    }),
    prisma.cardSortProposal.findMany({ where: { roundId } }),
  ])

  const proposerIds = [...new Set(proposals.map((p) => p.userId))]
  const users = await prisma.user.findMany({
    where: { id: { in: proposerIds } },
    select: { id: true, name: true, email: true },
  })
  const userLabel = new Map(users.map((u) => [u.id, u.name || u.email || u.id]))

  const currentByObject = new Map(
    values.map((row) => [
      row.objectId,
      typeof row.value === "string" && row.value.length > 0 ? row.value : null,
    ])
  )
  const tallyObjects: TallyObject[] = objects.map((object) => ({
    objectId: object.id,
    title: object.title,
    currentValue: currentByObject.get(object.id) ?? null,
  }))
  const tallyProposals: TallyProposal[] = proposals.map((p) => ({
    objectId: p.objectId,
    userId: p.userId,
    userName: userLabel.get(p.userId) ?? p.userId,
    proposedValue: p.proposedValue,
    fromValue: p.fromValue,
    rationale: p.rationale,
  }))

  const byObject = tallyByObject(tallyObjects, tallyProposals)
  return {
    round: {
      id: round.id,
      name: round.name,
      state: round.state as CardSortRoundState,
      factorName: round.fieldDefinition.name,
    },
    options: factor.options,
    // Only objects somebody actually proposed on. A 139-row table of mostly
    // empty rows buries the signal the tally exists to show.
    objects: byObject.filter((tally) => tally.proposalCount > 0),
    contested: rankContested(byObject),
    flow: computeNetFlow(tallyProposals, factor.options),
    participantCount: proposerIds.length,
    proposalCount: proposals.length,
  }
}
