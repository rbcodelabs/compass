import { notFound, redirect } from "next/navigation"
import { auth } from "@/auth"
import { getWorkspace } from "@/lib/workspace"
import { CardSortError, loadCardSortBoard } from "@/lib/card-sort"
import { loadCardSortCardMeta } from "@/lib/card-sort-cards"
import { canProposeNewEntries, listCardSortNewEntries } from "@/lib/card-sort-new-entries"
import { CardSortNewEntries } from "@/components/card-sort/card-sort-new-entries"
import { WorkspacePage } from "@/components/patterns/workspace-page"
import { CardSortBoard } from "@/components/card-sort/card-sort-board"
import { CardSortKanban } from "@/components/card-sort/card-sort-kanban"
import { CardSortRoundActions, CardSortRoundSummary } from "@/components/card-sort/card-sort-round-header"

export const dynamic = "force-dynamic"

export default async function CardSortRoundPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string; roundId: string }>
  searchParams: Promise<{ view?: string }>
}) {
  const { orgSlug, workspaceSlug, roundId } = await params
  // Kanban unless the table is named explicitly. Anything unrecognised falls
  // through to the default rather than erroring — a truncated or hand-edited URL
  // should show the board, not a 400.
  const view = (await searchParams).view === "table" ? "table" : "kanban"
  const session = await auth()
  if (!session?.user?.id) redirect("/login")

  const workspace = await getWorkspace(orgSlug, workspaceSlug, session.user.id)
  if (!workspace) notFound()

  // loadCardSortBoard checks the round belongs to this workspace, so a roundId
  // from another tenant is a NOT_FOUND here rather than a render of someone
  // else's board.
  let board
  try {
    board = await loadCardSortBoard({
      workspaceId: workspace.id,
      roundId,
      userId: session.user.id,
    })
  } catch (error) {
    if (error instanceof CardSortError && error.code === "NOT_FOUND") notFound()
    throw error
  }

  const newEntries = await listCardSortNewEntries({
    workspaceId: workspace.id,
    roundId,
    userId: session.user.id,
  })

  // Only the kanban shows real cards, so the table view skips the extra queries.
  const cards =
    view === "kanban"
      ? await loadCardSortCardMeta({
          workspaceId: workspace.id,
          objectType: board.round.objectType,
          objectIds: board.rows.map((row) => row.objectId),
        })
      : { meta: {}, showScore: false }

  // Shaped once and handed to whichever view renders, so the two cannot disagree
  // about the round they are showing.
  const round = {
    id: board.round.id,
    name: board.round.name,
    state: board.round.state,
    factorName: board.round.factorName,
    proposalCount: board.round.proposalCount,
    myProposalCount: board.round.myProposalCount,
  }

  return (
    <WorkspacePage
      title={board.round.name}
      description={
        <CardSortRoundSummary
          round={round}
          factorName={board.factor.name}
          rowCount={board.rows.length}
          canSeeTally={board.canSeeTally}
          allRoundsHref={`/${orgSlug}/${workspaceSlug}/card-sort`}
          howTo={
            round.state !== "OPEN"
              ? "Proposals are frozen. Click a title to open its details."
              : view === "kanban"
                ? "Drag a card by its handle to another column, right-click it, or use its … menu. Drag it back or press × to withdraw. Click a title to open its details."
                : "Right-click a row or use its … menu. Tick several rows to propose one move for all of them."
          }
        />
      }
      actions={
        <CardSortRoundActions
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          round={round}
          view={view}
          isFacilitator={board.isFacilitator}
          canSeeTally={board.canSeeTally}
        />
      }
    >
      {view === "kanban" ? (
        <CardSortKanban
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          round={round}
          objectType={board.round.objectType}
          factor={board.factor}
          rows={board.rows}
          cardMeta={cards.meta}
          showScore={cards.showScore}
          // Already filtered by the server according to the round's state. The
          // kanban renders whatever arrives and decides nothing about visibility.
          proposals={board.proposals}
          isFacilitator={board.isFacilitator}
          canSeeTally={board.canSeeTally}
          view={view}
          // Filtered by the server in the query itself; see listCardSortNewEntries.
          newEntries={newEntries}
          canProposeNewEntries={canProposeNewEntries(board.round)}
          canResolveNewEntries={board.isFacilitator && board.round.state !== "CLOSED"}
        />
      ) : (
        <>
          {/* The table has no columns to hold a card, so it keeps the list. */}
          <CardSortNewEntries
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            roundId={roundId}
            canPropose={canProposeNewEntries(board.round)}
            canResolve={board.isFacilitator && board.round.state !== "CLOSED"}
            options={board.factor.options}
            entries={newEntries}
          />
          <CardSortBoard
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            round={round}
            factor={board.factor}
            rows={board.rows}
            isFacilitator={board.isFacilitator}
            canSeeTally={board.canSeeTally}
            view={view}
          />
        </>
      )}
    </WorkspacePage>
  )
}
