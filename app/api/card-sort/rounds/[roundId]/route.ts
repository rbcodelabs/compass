import { withCardSortContext } from "@/lib/card-sort-route"
import { CardSortError, loadCardSortBoard, setCardSortRoundState } from "@/lib/card-sort"

/** The sort board: objects, current buckets, and the caller's own proposals. */
export async function GET(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return withCardSortContext(request, ({ userId, workspaceId }) =>
    loadCardSortBoard({ workspaceId, roundId, userId })
  )
}

/** Reveal or close. Facilitator only — enforced in setCardSortRoundState. */
export async function PATCH(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  const body = (await request.json().catch(() => null)) as { state?: unknown } | null

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    if (body?.state !== "REVEALED" && body?.state !== "CLOSED") {
      throw new CardSortError("INVALID_VALUE", "state must be REVEALED or CLOSED")
    }
    const round = await setCardSortRoundState({
      workspaceId,
      roundId,
      userId,
      state: body.state,
    })
    return { round }
  })
}
