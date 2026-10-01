/**
 * The compact top and bottom of both tally views (table and flow).
 *
 * Replaces the "Read this before reading the numbers" banners with the
 * compact copy: one state line with an ⓘ, one short caveat that
 * stays on screen because it is the thing people get wrong, and the longer
 * explanation in a collapsible at the foot of the page.
 *
 * The caveat is not optional and not behind a click. Proposals are sparse —
 * only disagreements are recorded — so silence is not agreement, and there is
 * deliberately no "% who agree" anywhere, because no such number exists.
 */

import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import Link from "next/link"
import { InfoHint } from "./card-sort-info"
import type { CardSortTally } from "@/lib/card-sort"

const STATE_LABEL: Record<string, string> = { OPEN: "Open", REVEALED: "Revealed", CLOSED: "Closed" }

/** The tally's top-bar subtitle: state, factor, counts, hover ⓘ, back link. */
export function TallySummary({ tally, boardHref }: { tally: CardSortTally; boardHref: string }) {
  const people = tally.participantCount
  const moves = tally.proposalCount

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge
        variant={tally.round.state === "OPEN" ? "default" : "secondary"}
        className="h-4 px-1.5 text-[10px]"
      >
        {STATE_LABEL[tally.round.state] ?? tally.round.state}
      </Badge>
      <span>{tally.round.factorName}</span>
      <span aria-hidden>&middot;</span>
      <span>
        {moves} proposed move{moves === 1 ? "" : "s"} from {people}{" "}
        {people === 1 ? "person" : "people"}
      </span>
      <InfoHint label="How the tally works">
        <p>
          Each person has at most one proposal per item. Changing your mind replaces your earlier
          proposal; it is never counted twice.
        </p>
        <p>
          Nothing here changes the official {tally.round.factorName}. The tally only shows what
          people proposed.
        </p>
      </InfoHint>
      <span aria-hidden>&middot;</span>
      <Link href={boardHref} className="underline underline-offset-2 hover:text-text-primary">
        Back to the board
      </Link>
    </span>
  )
}

/**
 * The caveat that stays on screen in the body — not in a hover — because it is
 * the thing people get wrong.
 */
export function TallyIntro() {
  return (
    <section>
      <p className="flex items-center gap-1.5 text-xs text-text-secondary">
        <span
          aria-hidden
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-status-warning-surface text-[10px] font-bold text-status-warning"
        >
          !
        </span>
        <span>
          Counts show disagreement only &mdash; no proposal means no opinion recorded, not
          agreement.
        </span>
      </p>
    </section>
  )
}

export function TallyHowItWorks({ tally, flow = false }: { tally: CardSortTally; flow?: boolean }) {
  return (
    <Collapsible className="max-w-prose text-xs text-text-secondary">
      <CollapsibleTrigger className="cursor-pointer font-medium text-text-primary">
        How these numbers work
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 space-y-1.5 leading-5">
        {flow && (
          <p>
            Arrow weight is the number of proposals for that move. A column with no outgoing arrows
            is one nobody asked to change &mdash; not one the round endorsed.
          </p>
        )}
        <p>
          Net is inflow minus outflow. Every move leaves one bucket and enters another, so net
          figures sum to zero unless some proposals came from items with no{" "}
          {tally.round.factorName} yet.
        </p>
        <p>
          Silence is not measured. An item that appears nowhere means nobody recorded an opinion on
          it, which is why there is no &ldquo;% who agree&rdquo; on this page.
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}
