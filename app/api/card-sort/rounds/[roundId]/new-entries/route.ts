import { withCardSortContext } from "@/lib/card-sort-route"
import { CardSortError } from "@/lib/card-sort"
import {
  acceptCardSortNewEntry,
  listCardSortNewEntries,
  proposeCardSortNewEntry,
  rejectCardSortNewEntry,
  withdrawCardSortNewEntry,
} from "@/lib/card-sort-new-entries"

/**
 * Proposed new entries for a round.
 *
 * REST only: there is deliberately no MCP tool for this. Agent writes to card
 * sort are denied in lib/mcp-tool-gates.ts, and asking a facilitator to accept
 * an entry is a human decision.
 *
 * GET returns only what the caller is allowed to see — their own entries on an
 * OPEN round (everyone's for the facilitator), everyone's once revealed. The
 * filtering happens in the query, see listCardSortNewEntries.
 */
type RouteParams = { params: Promise<{ roundId: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { roundId } = await params
  return withCardSortContext(request, async ({ userId, workspaceId }) => ({
    entries: await listCardSortNewEntries({ workspaceId, roundId, userId }),
  }))
}

/** Propose a new entry. */
export async function POST(request: Request, { params }: RouteParams) {
  const { roundId } = await params
  const body = (await request.json().catch(() => null)) as {
    title?: unknown
    description?: unknown
    suggestedValue?: unknown
  } | null

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    if (typeof body?.title !== "string") {
      throw new CardSortError("INVALID_VALUE", "title is required")
    }
    const entry = await proposeCardSortNewEntry({
      workspaceId,
      roundId,
      userId,
      title: body.title,
      description: typeof body.description === "string" ? body.description : null,
      suggestedValue: typeof body.suggestedValue === "string" ? body.suggestedValue : null,
    })
    return { id: entry.id }
  })
}

/** Facilitator only: accept (creates the Opportunity) or reject an entry. */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { roundId } = await params
  const body = (await request.json().catch(() => null)) as {
    entryId?: unknown
    action?: unknown
    note?: unknown
  } | null

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    if (typeof body?.entryId !== "string" || !body.entryId) {
      throw new CardSortError("INVALID_VALUE", "entryId is required")
    }
    if (body.action === "accept") {
      return acceptCardSortNewEntry({ workspaceId, roundId, userId, entryId: body.entryId })
    }
    if (body.action === "reject") {
      return rejectCardSortNewEntry({
        workspaceId,
        roundId,
        userId,
        entryId: body.entryId,
        note: typeof body.note === "string" ? body.note : null,
      })
    }
    throw new CardSortError("INVALID_VALUE", 'action must be "accept" or "reject"')
  })
}

/** Withdraw the caller's own pending entry. */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { roundId } = await params
  const entryId = new URL(request.url).searchParams.get("entryId")

  return withCardSortContext(request, async ({ userId, workspaceId }) => {
    if (!entryId) throw new CardSortError("INVALID_VALUE", "entryId is required")
    return withdrawCardSortNewEntry({ workspaceId, roundId, userId, entryId })
  })
}
