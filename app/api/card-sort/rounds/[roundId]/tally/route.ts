import { withCardSortContext } from "@/lib/card-sort-route"
import { getCardSortTally } from "@/lib/card-sort"

/**
 * The tally — and the only endpoint that returns anybody else's proposals.
 *
 * getCardSortTally calls assertCanSeeOtherProposals before it reads a single
 * proposal row, so hitting this URL directly on an OPEN round as a participant
 * returns 403 HIDDEN_UNTIL_REVEALED rather than a payload. That is the
 * server-side half of hidden-until-revealed, and
 * __tests__/card-sort-visibility.integration.test.ts asserts it against this
 * route handler rather than against the library function, precisely so the
 * check cannot be satisfied by the UI declining to render something.
 */
export async function GET(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return withCardSortContext(request, ({ userId, workspaceId }) =>
    getCardSortTally({ workspaceId, roundId, userId })
  )
}
