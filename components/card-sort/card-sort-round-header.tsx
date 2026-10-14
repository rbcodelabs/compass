"use client"

import type React from "react"
import { useState } from "react"
import Link from "next/link"
import { Eye, Columns3, Table2 } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { CardSortViewToggle } from "./card-sort-view-toggle"
import { InfoHint } from "./card-sort-info"
import { useCardSortProposals } from "./use-card-sort-proposals"
import { cn } from "@/lib/utils"

/**
 * Round chrome, split across the page's top bar rather than a second header
 * inside the content:
 *
 *   - CardSortRoundSummary goes in the top bar's subtitle — state badge, counts,
 *     the one-line state sentence, and the explanation behind a hover ⓘ.
 *   - CardSortRoundActions goes in the top bar's action slot — view toggle,
 *     tally link, and the facilitator's reveal / close.
 *
 * Both are rendered once by the round page for whichever view is showing, so
 * the table and kanban cannot disagree about what state the round is in — the
 * one thing on the screen that must not be ambiguous.
 */

export type CardSortView = "kanban" | "table"

type RoundState = "OPEN" | "REVEALED" | "CLOSED"

const STATE_LABEL = { OPEN: "Open", REVEALED: "Revealed", CLOSED: "Closed" } as const

export function CardSortRoundSummary({
  round,
  factorName,
  rowCount,
  canSeeTally,
  howTo,
  allRoundsHref,
}: {
  round: {
    state: RoundState
    /** null while the caller may not see other people's proposals. */
    proposalCount: number | null
    myProposalCount: number
  }
  factorName: string
  rowCount: number
  canSeeTally: boolean
  /** View-specific sentence on how to propose, shown in the hover. */
  howTo?: React.ReactNode
  allRoundsHref: string
}) {
  // The facilitator line says the asymmetry out loud (canSeeOtherProposals lets
  // the creator see everyone while OPEN) so they do not assume the room can too.
  const stateLine =
    round.state === "OPEN"
      ? canSeeTally
        ? "You see everyone’s proposals; they don’t until you reveal."
        : "Your proposals stay private until reveal."
      : round.state === "REVEALED"
        ? "Everyone’s proposals are visible."
        : "Proposals are frozen."

  const counts = [
    `${rowCount} items`,
    `you proposed ${round.myProposalCount}`,
    // null, not zero, while the round is blind — printing "0 total" would report
    // an empty round rather than a hidden one.
    round.proposalCount !== null ? `${round.proposalCount} total` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge
        variant={round.state === "OPEN" ? "default" : "secondary"}
        className="h-4 px-1.5 text-[10px]"
      >
        {STATE_LABEL[round.state]}
      </Badge>
      <span>{factorName}</span>
      <span aria-hidden>&middot;</span>
      <span>{counts}</span>
      <span aria-hidden>&middot;</span>
      <span>{stateLine}</span>
      <InfoHint label="How this round works">
        <p>
          Moving a card records a <strong>proposal</strong>. It never changes the official{" "}
          {factorName} &mdash; the board stays the team&rsquo;s real state.
        </p>
        <p>
          While the round is open, participants only see their own proposals. When the facilitator
          reveals it, every proposal becomes visible and the tally opens.
        </p>
        <p>One proposal per item. Proposing again replaces your previous one.</p>
        {howTo && <p>{howTo}</p>}
      </InfoHint>
      <span aria-hidden>&middot;</span>
      <Link href={allRoundsHref} className="underline underline-offset-2 hover:text-text-primary">
        All rounds
      </Link>
    </span>
  )
}

export function CardSortRoundActions({
  orgSlug,
  workspaceSlug,
  round,
  view,
  isFacilitator,
  canSeeTally,
}: {
  orgSlug: string
  workspaceSlug: string
  round: { id: string; state: RoundState }
  view: CardSortView
  isFacilitator: boolean
  canSeeTally: boolean
}) {
  const base = `/${orgSlug}/${workspaceSlug}/card-sort/${round.id}`
  // Same hook the views use, so reveal / close is the same request it always was.
  const { patchRound, error, working } = useCardSortProposals({
    orgSlug,
    workspaceSlug,
    roundId: round.id,
  })

  // Reveal and close are one-way: nobody can un-read a revealed tally, and a
  // closed round cannot be reopened. Both go through a confirm so a stray click
  // (Close lands under the cursor right after Reveal) cannot do either.
  const [confirming, setConfirming] = useState<"REVEALED" | "CLOSED" | null>(null)
  async function confirm() {
    if (!confirming) return
    await patchRound(confirming)
    setConfirming(null)
  }

  return (
    <div className="flex items-center gap-2">
      {error && (
        <span role="alert" className="max-w-48 truncate text-xs text-status-danger" title={error}>
          {error}
        </span>
      )}
      <CardSortViewToggle
        label="Round view"
        options={[
          { href: `${base}?view=kanban`, label: "Kanban", icon: Columns3, current: view === "kanban" },
          { href: `${base}?view=table`, label: "Table", icon: Table2, current: view === "table" },
        ]}
      />
      {canSeeTally && (
        <Link href={`${base}/tally`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <Eye className="size-4" /> Tally
        </Link>
      )}
      {isFacilitator && round.state === "OPEN" && (
        <Button size="sm" onClick={() => setConfirming("REVEALED")} disabled={working}>
          Reveal to everyone
        </Button>
      )}
      {isFacilitator && round.state === "REVEALED" && (
        <Button size="sm" variant="outline" onClick={() => setConfirming("CLOSED")} disabled={working}>
          Close round
        </Button>
      )}
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && !working && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "CLOSED" ? "Close this round?" : "Reveal this round to everyone?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "CLOSED"
                ? "Closing archives the round. It cannot be reopened, and no one can change proposals afterwards. This cannot be undone."
                : "Everyone in the workspace will see all proposals and the tally, and no new proposals will be accepted. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirming === "CLOSED" ? "destructive" : "default"}
              disabled={working}
              onClick={confirm}
            >
              {confirming === "CLOSED" ? "Close round" : "Reveal to everyone"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
