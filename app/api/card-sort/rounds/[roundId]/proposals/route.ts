import { withCardSortContext } from "@/lib/card-sort-route"
import {
  CardSortError,
  listMyCardSortProposals,
  proposeCardSortMoves,
  withdrawCardSortProposal,
} from "@/lib/card-sort"

/**
 * The caller's own proposals only.
 *
 * There is deliberately no "all proposals" endpoint. Other people's proposals
 * are reachable exclusively through the tally, which runs
 * assertCanSeeOtherProposals — so there is no second read path that could be
 * built without the visibility check.
 */
export async function GET(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    const proposals = await listMyCardSortProposals({ workspaceId, roundId, userId })
    return { proposals }
  })
}

/**
 * Propose a move for one object or many.
 *
 * `objectIds` is always an array, even for a single row, so the single and
 * multi-select gestures share one code path rather than drifting apart.
 */
export async function POST(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  const body = (await request.json().catch(() => null)) as {
    objectIds?: unknown
    proposedValue?: unknown
    rationale?: unknown
  } | null

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    const objectIds = body?.objectIds
    if (
      !Array.isArray(objectIds) ||
      objectIds.length === 0 ||
      objectIds.some((id) => typeof id !== "string")
    ) {
      throw new CardSortError("INVALID_VALUE", "objectIds must be a non-empty array of ids")
    }
    if (typeof body?.proposedValue !== "string") {
      throw new CardSortError("INVALID_VALUE", "proposedValue is required")
    }
    return proposeCardSortMoves({
      workspaceId,
      roundId,
      userId,
      objectIds: objectIds as string[],
      proposedValue: body.proposedValue,
      rationale: typeof body.rationale === "string" ? body.rationale : null,
    })
  })
}

/** Withdraw the caller's own proposal, returning the object to "no opinion". */
export async function DELETE(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  const objectId = new URL(request.url).searchParams.get("objectId")

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    if (!objectId) throw new CardSortError("INVALID_VALUE", "objectId is required")
    return withdrawCardSortProposal({ workspaceId, roundId, userId, objectId })
  })
}
