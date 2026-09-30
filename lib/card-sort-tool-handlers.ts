/**
 * Handler functions for the card sort MCP tools.
 *
 * These are a thin shell over lib/card-sort.ts. Every rule that matters —
 * validating a proposed value against the factor's effective options, snapshotting
 * fromValue server-side, rejecting a no-op, and above all the hidden-until-REVEALED
 * check — lives in that module and therefore applies identically here and on the
 * HTTP routes. There is no second implementation to keep in step, and in
 * particular no MCP path that can read another participant's proposals during an
 * OPEN round.
 *
 * Every tool takes `workspaceId` as well as `roundId`, even where the round alone
 * would identify the row. That is what lets TOOL_GATES gate each of these with a
 * plain `assertWorkspaceMember` — the same shape as list_custom_field_definitions —
 * rather than needing a new entity resolver. lib/card-sort.ts independently
 * verifies the round actually belongs to that workspace, so passing someone
 * else's roundId with your own workspaceId is a 404, not a leak.
 */

import { ok, fail } from "@/lib/mcp-output"
import { getMcpActor, McpAuthzError } from "@/lib/mcp-authz"
import {
  CardSortError,
  createCardSortRound,
  getCardSortTally,
  listCardSortFactors,
  listCardSortRounds,
  listMyCardSortProposals,
  loadCardSortBoard,
  proposeCardSortMoves,
  setCardSortRoundState,
  withdrawCardSortProposal,
  type CardSortRoundState,
} from "@/lib/card-sort"
import { CONTESTED_DEFINITION } from "@/lib/card-sort-tally"
import type { CustomFieldObjectType } from "@/lib/types"

/**
 * A card sort proposal is one named person's opinion, so it needs an identity to
 * attribute it to. The shared service key has none — `userId` is null — and
 * inventing one would produce ballots nobody cast. Reads that are already
 * scoped to "mine" have the same problem, so they are refused too.
 */
function actingUserId(): string {
  const actor = getMcpActor()
  if (!actor.userId) {
    throw new McpAuthzError(
      "Card sort proposals are attributed to a person. This tool requires a per-user identity, not the shared service key."
    )
  }
  return actor.userId
}

/** Card sort errors are expected outcomes, not crashes — report them as tool failures. */
async function attempt<T>(run: () => Promise<T>): Promise<T | ToolFailure> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CardSortError) return { __fail: error.message }
    throw error
  }
}
type ToolFailure = { __fail: string }
const isFailure = (value: unknown): value is ToolFailure =>
  typeof value === "object" && value !== null && "__fail" in value

// ── list_card_sort_factors ──────────────────────────────────────────────────

export async function listCardSortFactorsTool({
  workspaceId,
  objectType,
}: {
  workspaceId: string
  objectType: CustomFieldObjectType
}) {
  const factors = await listCardSortFactors({ workspaceId, objectType })
  if (factors.length === 0) {
    return ok(
      `No SELECT custom fields on ${objectType} to sort by. A factor has to be a SELECT field with at least one option — its options become the buckets.`,
      { items: [], count: 0 }
    )
  }
  const lines = factors.map((factor) => {
    const source = factor.sharedOptionSetName
      ? `shared option set "${factor.sharedOptionSetName}"`
      : "its own options"
    return `- ${factor.name} (${factor.id}): ${factor.options.length} buckets from ${source} — ${factor.options
      .map((option) => option.label)
      .join(", ")}`
  })
  return ok(`${factors.length} possible factor(s) on ${objectType}:\n${lines.join("\n")}`, {
    items: factors,
    count: factors.length,
  })
}

// ── create_card_sort_round ─────────────────────────────────────────────────

export async function createCardSortRoundTool({
  workspaceId,
  name,
  fieldDefinitionId,
}: {
  workspaceId: string
  name: string
  fieldDefinitionId: string
}) {
  const userId = actingUserId()
  const result = await attempt(() =>
    createCardSortRound({ workspaceId, userId, name, fieldDefinitionId })
  )
  if (isFailure(result)) return fail(result.__fail)
  return ok(
    `Created card sort round "${result.name}" (${result.id}) on ${result.factorName}. It is OPEN: participants can propose moves, and nobody but you can see anyone else's proposals or the tally until you reveal it.`,
    result
  )
}

// ── list_card_sort_rounds ──────────────────────────────────────────────────

export async function listCardSortRoundsTool({
  workspaceId,
  state,
}: {
  workspaceId: string
  state?: CardSortRoundState
}) {
  const userId = actingUserId()
  const rounds = await listCardSortRounds({ workspaceId, userId, state })
  if (rounds.length === 0) {
    return ok("No card sort rounds found.", { items: [], count: 0 })
  }
  const lines = rounds.map((round) => {
    // null means "you are a participant on an OPEN round", not zero. Printing a
    // number here would leak the thing the round is hiding.
    const total =
      round.proposalCount === null
        ? "total hidden until revealed"
        : `${round.proposalCount} proposal(s) total`
    return `- ${round.name} (${round.id}): ${round.state}, factor ${round.factorName}, ${total}, ${round.myProposalCount} from you`
  })
  return ok(`${rounds.length} card sort round(s):\n${lines.join("\n")}`, {
    items: rounds,
    count: rounds.length,
  })
}

// ── set_card_sort_round_state ──────────────────────────────────────────────

export async function setCardSortRoundStateTool({
  workspaceId,
  roundId,
  state,
}: {
  workspaceId: string
  roundId: string
  state: "REVEALED" | "CLOSED"
}) {
  const userId = actingUserId()
  const result = await attempt(() =>
    setCardSortRoundState({ workspaceId, roundId, userId, state })
  )
  if (isFailure(result)) return fail(result.__fail)
  const note =
    state === "REVEALED"
      ? " Everyone in the workspace can now see the tally. This cannot be undone."
      : " No further proposals will be accepted."
  return ok(`Round "${result.name}" is now ${result.state}.${note}`, result)
}

// ── propose_card_sort_move ─────────────────────────────────────────────────

export async function proposeCardSortMoveTool({
  workspaceId,
  roundId,
  objectIds,
  proposedValue,
  rationale,
}: {
  workspaceId: string
  roundId: string
  objectIds: string[]
  proposedValue: string
  rationale?: string
}) {
  const userId = actingUserId()
  const result = await attempt(() =>
    proposeCardSortMoves({
      workspaceId,
      roundId,
      userId,
      objectIds,
      proposedValue,
      rationale: rationale ?? null,
    })
  )
  if (isFailure(result)) return fail(result.__fail)
  const skippedNote = result.skipped.length
    ? ` Skipped ${result.skipped.length}: ${result.skipped
        .map((entry) => `${entry.objectId} (${entry.code})`)
        .join(", ")}.`
    : ""
  return ok(
    `Recorded ${result.applied.length} proposal(s) to move to "${proposedValue}".${skippedNote}`,
    result
  )
}

// ── withdraw_card_sort_proposal ────────────────────────────────────────────

export async function withdrawCardSortProposalTool({
  workspaceId,
  roundId,
  objectId,
}: {
  workspaceId: string
  roundId: string
  objectId: string
}) {
  const userId = actingUserId()
  const result = await attempt(() =>
    withdrawCardSortProposal({ workspaceId, roundId, userId, objectId })
  )
  if (isFailure(result)) return fail(result.__fail)
  return ok(
    "Withdrew your proposal. That object now records no opinion from you — which is not the same as you proposing it stay where it is.",
    result
  )
}

// ── get_card_sort_proposals (the caller's own) ─────────────────────────────

export async function getCardSortProposalsTool({
  workspaceId,
  roundId,
}: {
  workspaceId: string
  roundId: string
}) {
  const userId = actingUserId()
  const result = await attempt(() => listMyCardSortProposals({ workspaceId, roundId, userId }))
  if (isFailure(result)) return fail(result.__fail)
  if (result.length === 0) {
    return ok("You have not proposed any moves in this round.", { items: [], count: 0 })
  }
  const lines = result.map(
    (proposal) =>
      `- ${proposal.objectTitle}: ${proposal.fromValue ?? "(unset)"} → ${proposal.proposedValue}${
        proposal.rationale ? ` — ${proposal.rationale}` : ""
      }`
  )
  return ok(`Your ${result.length} proposal(s) in this round:\n${lines.join("\n")}`, {
    items: result,
    count: result.length,
  })
}

// ── get_card_sort_board ────────────────────────────────────────────────────

export async function getCardSortBoardTool({
  workspaceId,
  roundId,
}: {
  workspaceId: string
  roundId: string
}) {
  const userId = actingUserId()
  const result = await attempt(() => loadCardSortBoard({ workspaceId, roundId, userId }))
  if (isFailure(result)) return fail(result.__fail)
  const byBucket = new Map<string, string[]>()
  for (const row of result.rows) {
    const key = row.currentValue ?? "(unset)"
    const mine = row.myProposedValue ? ` [you propose → ${row.myProposedValue}]` : ""
    byBucket.set(key, [...(byBucket.get(key) ?? []), `${row.title}${mine}`])
  }
  const lines = [...byBucket].map(([bucket, titles]) => `${bucket} (${titles.length}):\n  ${titles.join("\n  ")}`)
  return ok(
    `Round "${result.round.name}" on ${result.factor.name}, ${result.round.state}. ${result.rows.length} object(s) grouped by current value. Only your own proposals appear here.\n\n${lines.join("\n")}`,
    result
  )
}

// ── get_card_sort_tally ────────────────────────────────────────────────────

export async function getCardSortTallyTool({
  workspaceId,
  roundId,
}: {
  workspaceId: string
  roundId: string
}) {
  const userId = actingUserId()
  const result = await attempt(() => getCardSortTally({ workspaceId, roundId, userId }))
  if (isFailure(result)) return fail(result.__fail)

  if (result.objects.length === 0) {
    return ok("Nobody has proposed a move in this round yet.", { ...result, items: [] })
  }
  const objectLines = result.objects.map((object) => {
    const targets = object.targets
      .map(
        (target) =>
          `${target.value} ×${target.count} (${target.proposers.map((p) => p.userName).join(", ")})`
      )
      .join("; ")
    return `- ${object.title} — currently ${object.currentValue ?? "(unset)"} → ${targets}`
  })
  const flowLines = result.flow.buckets
    .filter((bucket) => bucket.inflow > 0 || bucket.outflow > 0)
    .map((bucket) => `${bucket.value}: +${bucket.inflow} / -${bucket.outflow} = net ${bucket.net}`)
  const contestedLines = result.contested
    .slice(0, 10)
    .map(
      (object) =>
        `${object.title} (${object.distinctTargetCount} different target(s) across ${object.proposalCount} proposal(s))`
    )

  return ok(
    [
      `Round "${result.round.name}" on ${result.round.factorName}, ${result.round.state}.`,
      `${result.proposalCount} proposal(s) from ${result.participantCount} participant(s) across ${result.objects.length} object(s).`,
      "",
      "Proposals are sparse: an object with no proposals means nobody recorded an opinion on it, NOT that everyone agreed with its current bucket.",
      "",
      "Proposed moves:",
      ...objectLines,
      "",
      "Net flow between buckets:",
      ...(flowLines.length ? flowLines : ["(no flow)"]),
      ...(result.flow.fromUnsetCount
        ? [`${result.flow.fromUnsetCount} proposal(s) came from objects with no current value.`]
        : []),
      "",
      `Most contested. ${CONTESTED_DEFINITION}`,
      ...contestedLines,
    ].join("\n"),
    result
  )
}
