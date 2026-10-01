/**
 * The tally.
 *
 * No "use client" — nothing here is interactive, so it renders on the server and
 * the participant list never reaches a browser that was not allowed to see it.
 * The authorization itself is in lib/card-sort.ts; this is just not undoing it.
 *
 * Two things this view must say out loud, because getting either wrong turns the
 * numbers into a false mandate:
 *
 *   1. Proposals are sparse. An object with no proposals means nobody recorded an
 *      opinion — not that the room agreed with its current bucket. The banner
 *      states this above the table rather than in a footnote.
 *   2. "Contested" has exactly one definition, and it is CONTESTED_DEFINITION,
 *      imported from the module whose comparator implements it. Paraphrasing it
 *      here would let the prose and the ranking drift apart.
 */

import { ArrowRight, TrendingUp, TrendingDown } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CONTESTED_DEFINITION } from "@/lib/card-sort-tally"
import { TallyHowItWorks, TallyIntro } from "./card-sort-tally-intro"
import type { CardSortTally } from "@/lib/card-sort"

const UNSET = "— no value —"

export function CardSortTallyView({ tally }: { tally: CardSortTally }) {
  const labelFor = (value: string | null) =>
    value == null ? UNSET : tally.options.find((option) => option.value === value)?.label ?? value

  const movers = tally.objects.filter((object) => object.proposalCount > 0)
  const activeBuckets = tally.flow.buckets.filter(
    (bucket) => bucket.inflow > 0 || bucket.outflow > 0
  )

  return (
    <div className="flex flex-col gap-6">
      <TallyIntro />

      {tally.proposalCount === 0 && (
        <p className="text-sm text-text-secondary">
          Nobody has proposed a move in this round yet.
        </p>
      )}

      {movers.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Proposed moves, by object</h2>
          <div className="overflow-hidden rounded-md ring-1 ring-border-default">
            <Table>
              <TableHeader className="bg-surface-panel">
                <TableRow>
                  <TableHead scope="col" className="px-3 py-2">Object</TableHead>
                  <TableHead scope="col" className="px-3 py-2">
                    Current {tally.round.factorName}
                  </TableHead>
                  <TableHead scope="col" className="px-3 py-2">Proposed targets</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movers.map((object) => (
                  <TableRow key={object.objectId} className="align-top">
                    <TableCell className="px-3 py-2">
                      {object.title}
                      {object.unanimousMove && (
                        <Badge variant="outline" className="ml-2">
                          unanimous move
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-text-secondary">
                      {labelFor(object.currentValue)}
                    </TableCell>
                    <TableCell className="px-3 py-2 whitespace-normal">
                      <ul className="flex flex-col gap-1">
                        {object.targets.map((target) => (
                          <li key={target.value} className="flex flex-wrap items-baseline gap-1.5">
                            <ArrowRight className="size-3 self-center" />
                            <span className="font-medium">{labelFor(target.value)}</span>
                            <span className="text-text-secondary">&times;{target.count}</span>
                            <span className="text-xs text-text-secondary">
                              {target.proposers.map((proposer) => proposer.userName).join(", ")}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {activeBuckets.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Net flow between buckets</h2>
          <p className="text-xs text-text-secondary">
            Which buckets the round wants to grow and which it wants to drain. Positive net means
            more proposals point into a bucket than out of it.
          </p>
          <div className="overflow-hidden rounded-md ring-1 ring-border-default">
            <Table>
              <TableHeader className="bg-surface-panel">
                <TableRow>
                  <TableHead scope="col" className="px-3 py-2">Bucket</TableHead>
                  <TableHead scope="col" className="px-3 py-2">In</TableHead>
                  <TableHead scope="col" className="px-3 py-2">Out</TableHead>
                  <TableHead scope="col" className="px-3 py-2">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {activeBuckets.map((bucket) => (
                  <TableRow key={bucket.value}>
                    <TableCell className="px-3 py-2">{labelFor(bucket.value)}</TableCell>
                    <TableCell className="px-3 py-2 text-text-secondary">{bucket.inflow}</TableCell>
                    <TableCell className="px-3 py-2 text-text-secondary">{bucket.outflow}</TableCell>
                    <TableCell className="px-3 py-2 font-medium">
                      <span className="inline-flex items-center gap-1">
                        {bucket.net > 0 && <TrendingUp className="size-3.5" />}
                        {bucket.net < 0 && <TrendingDown className="size-3.5" />}
                        {bucket.net > 0 ? `+${bucket.net}` : bucket.net}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {tally.flow.fromUnsetCount > 0 && (
            <p className="text-xs text-text-secondary">
              {tally.flow.fromUnsetCount === 1
                ? `1 proposal came from an object that had no ${tally.round.factorName} value, so it adds`
                : `${tally.flow.fromUnsetCount} proposals came from objects that had no ${tally.round.factorName} value, so they add`}{" "}
              to an inflow without any bucket&rsquo;s outflow. That is why the Net column does not
              sum to zero.
            </p>
          )}

          {tally.flow.edges.length > 0 && (
            <Collapsible className="text-xs text-text-secondary">
              <CollapsibleTrigger className="cursor-pointer underline decoration-dotted">
                Every directional edge ({tally.flow.edges.length})
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="mt-1 flex flex-col gap-0.5 pl-4">
                  {tally.flow.edges.map((edge) => (
                    <li key={`${edge.from ?? "unset"}->${edge.to}`}>
                      {labelFor(edge.from)} &rarr; {labelFor(edge.to)}: {edge.count}
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          )}
        </section>
      )}

      {tally.contested.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Most contested</h2>
          {/*
            CONTESTED_DEFINITION is rendered verbatim, not summarised. The
            ranking is only trustworthy if the reader can see the rule it used.
          */}
          <p className="text-xs text-text-secondary">{CONTESTED_DEFINITION}</p>
          <ol className="flex flex-col gap-1 text-sm">
            {tally.contested.map((object, index) => (
              <li key={object.objectId} className="flex flex-wrap items-baseline gap-2">
                <span className="text-text-secondary">{index + 1}.</span>
                <span>{object.title}</span>
                <Badge variant="secondary">
                  {object.distinctTargetCount} distinct target
                  {object.distinctTargetCount === 1 ? "" : "s"}
                </Badge>
                <span className="text-xs text-text-secondary">
                  {object.proposalCount} proposal{object.proposalCount === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <TallyHowItWorks tally={tally} />
    </div>
  )
}
