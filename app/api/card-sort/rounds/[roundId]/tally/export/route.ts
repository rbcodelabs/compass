import { withCardSortContext } from "@/lib/card-sort-route"
import { getCardSortTally, type CardSortTally } from "@/lib/card-sort"
import { buildCardSortCsv } from "@/lib/card-sort-export"
import { csvDownloadResponse, csvFilenameStem } from "@/lib/csv"

/**
 * CSV download of the tally — one row per proposal.
 *
 * The data comes from getCardSortTally, the same function behind the tally
 * route, so the hidden-until-revealed gate (assertCanSeeOtherProposals) runs
 * before a single proposal row is read. A participant hitting this URL on an
 * OPEN round gets 403 HIDDEN_UNTIL_REVEALED, never a file. Do not replace this
 * with a direct proposals query: that would be a second read path with no gate.
 */
export async function GET(request: Request, { params }: { params: Promise<{ roundId: string }> }) {
  const { roundId } = await params
  return withCardSortContext(
    request,
    ({ userId, workspaceId }) => getCardSortTally({ workspaceId, roundId, userId }),
    (data) => {
      const tally = data as CardSortTally
      const date = new Date().toISOString().slice(0, 10)
      return csvDownloadResponse(
        buildCardSortCsv(tally),
        `${csvFilenameStem(tally.round.name, "card-sort")}-tally-${date}.csv`
      )
    }
  )
}
