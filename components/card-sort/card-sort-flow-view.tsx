/**
 * The tally as columns and weighted flow arrows.
 *
 * No "use client" on this module. The drill-ins are Collapsibles, which are
 * client components, but the authorization is upstream in lib/card-sort.ts and
 * this file adds no branch that could fetch data the table view would not have.
 *
 * ── It consumes the tally arithmetic; it does not redo it ───────────────────
 *
 * Every number rendered here comes from `tally.flow` — `edges`, `buckets`,
 * `fromUnsetCount` — computed by computeNetFlow in lib/card-sort-tally.ts and
 * covered by 17 assertions. Nothing below counts a proposal. A second
 * implementation of the same arithmetic in a view is how two screens end up
 * disagreeing about the same round, and the one in the pure module is the one
 * with the tests.
 *
 * The object lists under each arrow are the exception that proves the rule: they
 * are a *lookup* of which objects sit behind an edge, deliberately derived from
 * each object's LIVE `currentValue`, not from the proposals' `fromValue`
 * snapshots that the edge counts are built from. Those two can differ once a
 * facilitator reconciles a value, so the listed rows can be fewer than the edge's
 * count — which is why the count shown is always the edge's own and a note
 * appears when the two disagree, rather than quietly substituting the shorter
 * list's length.
 *
 * ── Nothing readable in the table may be unreadable here ───────────────────
 *
 * The brief's requirement. So the sparse-delta warning, every object's proposed
 * targets, its proposers, their rationales, the unanimous-move badge, the
 * from-unset footnote and the contested ranking are all present — the arrows are
 * an addition to the tally, not a lossy summary of it.
 */

import { ArrowRight, TrendingDown, TrendingUp, Users } from "lucide-react"

import { Board, BoardColumn } from "@/components/patterns/board"
import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { CONTESTED_DEFINITION } from "@/lib/card-sort-tally"
import { TallyHowItWorks, TallyIntro } from "./card-sort-tally-intro"
import type { FlowEdge, ObjectTally } from "@/lib/card-sort-tally"
import { NO_VALUE_COLUMN_LABEL } from "@/lib/card-sort-kanban"
import type { CardSortTally } from "@/lib/card-sort"

/** One column of the flow board. `value` null is the no-value column. */
type FlowColumn = {
  value: string | null
  label: string
  inflow: number
  outflow: number
  net: number
  out: FlowEdge[]
  objects: ObjectTally[]
}

function ProposerList({ target }: { target: ObjectTally["targets"][number] }) {
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5 pl-4 text-xs text-text-secondary">
      {target.proposers.map((proposer) => (
        <li key={proposer.userId}>
          <span className="font-medium">{proposer.userName}</span>
          {proposer.rationale ? `: ${proposer.rationale}` : " (no rationale given)"}
        </li>
      ))}
    </ul>
  )
}

export function CardSortFlowView({ tally }: { tally: CardSortTally }) {
  const labelFor = (value: string | null) =>
    value == null
      ? NO_VALUE_COLUMN_LABEL
      : tally.options.find((option) => option.value === value)?.label ?? value

  const movers = tally.objects.filter((object) => object.proposalCount > 0)

  // Bucket order comes from computeNetFlow: declared options first, then any
  // value that only appears in proposal data. The no-value column is appended
  // last, matching where the kanban and the table put unset objects, and only
  // when there is something to put in it.
  const unsetMovers = movers.filter((object) => object.currentValue === null)
  const columns: FlowColumn[] = [
    ...tally.flow.buckets.map((bucket) => ({
      value: bucket.value as string | null,
      label: labelFor(bucket.value),
      inflow: bucket.inflow,
      outflow: bucket.outflow,
      net: bucket.net,
      out: tally.flow.edges.filter((edge) => edge.from === bucket.value),
      objects: movers.filter((object) => object.currentValue === bucket.value),
    })),
  ]
  if (unsetMovers.length > 0 || tally.flow.fromUnsetCount > 0) {
    columns.push({
      value: null,
      label: NO_VALUE_COLUMN_LABEL,
      // An unset object has no bucket, so it can only ever be a source. Its
      // proposals are counted in fromUnsetCount, not in any bucket's outflow —
      // the asymmetry NetFlow documents.
      inflow: 0,
      outflow: tally.flow.fromUnsetCount,
      net: -tally.flow.fromUnsetCount,
      out: tally.flow.edges.filter((edge) => edge.from === null),
      objects: unsetMovers,
    })
  }

  // Arrow thickness is relative to the heaviest edge in the round, not to an
  // absolute scale: what a reader needs from the picture is which move dominates
  // this round, and a fixed scale makes every edge in a small round look trivial.
  const heaviest = tally.flow.edges[0]?.count ?? 1

  return (
    <div className="flex flex-col gap-6">
      <TallyIntro />

      {tally.proposalCount === 0 && (
        <p className="text-sm text-text-secondary">
          Nobody has proposed a move in this round yet, so there is nothing to draw.
        </p>
      )}

      <Board label={`${tally.round.factorName} proposal flow`} className="items-start">
        {columns.map((column) => (
          <BoardColumn
            key={column.value ?? "__unset__"}
            aria-label={`${column.label} column`}
            title={column.label}
            count={column.objects.length}
            description={
              <span className="inline-flex items-center gap-2">
                <span>in {column.inflow}</span>
                <span>out {column.outflow}</span>
                <span className="inline-flex items-center gap-0.5 font-medium text-text-secondary">
                  {column.net > 0 && <TrendingUp className="size-3" aria-hidden />}
                  {column.net < 0 && <TrendingDown className="size-3" aria-hidden />}
                  net {column.net > 0 ? `+${column.net}` : column.net}
                </span>
              </span>
            }
          >
            {column.out.length > 0 && (
              <section
                aria-label={`Proposed moves out of ${column.label}`}
                className="flex flex-col gap-1"
              >
                <h4 className="text-xs font-medium text-text-subtle">Wants to move to</h4>
                {column.out.map((edge) => {
                  // The objects behind this edge, looked up by live value. See the
                  // module comment: the authoritative count is edge.count.
                  const behind = column.objects
                    .map((object) => ({
                      object,
                      target: object.targets.find((candidate) => candidate.value === edge.to),
                    }))
                    .filter(
                      (entry): entry is { object: ObjectTally; target: ObjectTally["targets"][number] } =>
                        entry.target !== undefined
                    )
                  const listed = behind.reduce((sum, entry) => sum + entry.target.count, 0)

                  return (
                    <Collapsible key={`${edge.from ?? "unset"}->${edge.to}`}>
                      <CollapsibleTrigger className="flex w-full flex-col gap-1 rounded-md border border-border-default bg-surface-panel px-2 py-1.5 text-left">
                        <span className="flex w-full items-center gap-1 text-xs">
                          <ArrowRight className="size-3 shrink-0" aria-hidden />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {labelFor(edge.to)}
                          </span>
                          <Users className="size-3 shrink-0 text-text-subtle" aria-hidden />
                          <span className="text-text-secondary">{edge.count}</span>
                        </span>
                        {/*
                          Width is inline because it is data, not design: it is
                          edge.count as a fraction of the heaviest edge, which no
                          fixed set of utility classes can express.
                        */}
                        <span
                          aria-hidden
                          className="h-1 rounded-full bg-status-info"
                          style={{ width: `${Math.max(6, (edge.count / heaviest) * 100)}%` }}
                        />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="pt-1">
                        {behind.length === 0 ? (
                          <p className="pl-4 text-xs text-text-subtle">
                            No object currently in {column.label} carries this proposal &mdash; the{" "}
                            {edge.count === 1 ? "proposal" : "proposals"} behind this arrow{" "}
                            {edge.count === 1 ? "was" : "were"} made before the official value
                            changed.
                          </p>
                        ) : (
                          <ul className="flex flex-col gap-1 pl-1">
                            {behind.map(({ object, target }) => (
                              <li key={object.objectId} className="text-xs">
                                <span className="font-medium text-text-primary">{object.title}</span>
                                <ProposerList target={target} />
                              </li>
                            ))}
                          </ul>
                        )}
                        {listed !== edge.count && behind.length > 0 && (
                          <p className="mt-1 pl-1 text-xs text-text-subtle">
                            {edge.count} proposal{edge.count === 1 ? "" : "s"} counted for this
                            move, {listed} shown: the rest were recorded against an official value
                            that has since changed.
                          </p>
                        )}
                      </CollapsibleContent>
                    </Collapsible>
                  )
                })}
              </section>
            )}

            {column.objects.length > 0 && (
              <section
                aria-label={`Objects in ${column.label} with proposals`}
                className="flex flex-col gap-2 pt-1"
              >
                <h4 className="text-xs font-medium text-text-subtle">Objects with proposals</h4>
                {column.objects.map((object) => (
                  <Collapsible
                    key={object.objectId}
                    className="rounded-lg border border-border-default bg-surface-panel p-2"
                  >
                    <CollapsibleTrigger className="flex w-full flex-col gap-1 text-left">
                      <span className="text-sm font-medium text-text-primary">{object.title}</span>
                      <span className="flex flex-wrap items-center gap-1">
                        {object.targets.map((target) => (
                          <Badge key={target.value} variant="outline" className="gap-1 text-xs">
                            <ArrowRight className="size-3" aria-hidden />
                            {labelFor(target.value)}
                            <span className="text-text-secondary">&times;{target.count}</span>
                          </Badge>
                        ))}
                        {object.unanimousMove && (
                          <Badge variant="secondary" className="text-xs">
                            unanimous move
                          </Badge>
                        )}
                      </span>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-1">
                      {object.targets.map((target) => (
                        <div key={target.value} className="text-xs">
                          <span className="font-medium">{labelFor(target.value)}</span>
                          <ProposerList target={target} />
                        </div>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </section>
            )}

            {column.out.length === 0 && column.objects.length === 0 && (
              <p className="text-xs text-text-subtle">Nobody proposed moving anything out of here.</p>
            )}
          </BoardColumn>
        ))}
      </Board>

      {tally.flow.fromUnsetCount > 0 && (
        <p className="text-xs text-text-secondary">
          {tally.flow.fromUnsetCount === 1
            ? `1 proposal came from an object that had no ${tally.round.factorName} value, so it adds`
            : `${tally.flow.fromUnsetCount} proposals came from objects that had no ${tally.round.factorName} value, so they add`}{" "}
          to an inflow without any bucket&rsquo;s outflow. That is why the net figures do not sum to
          zero.
        </p>
      )}

      {tally.contested.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Most contested</h2>
          {/* Verbatim, for the same reason as in the table view. */}
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

      <TallyHowItWorks tally={tally} flow />
    </div>
  )
}
