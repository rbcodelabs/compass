"use client"

import Link from "next/link"
import { Section } from "./panel-parts"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useLabels, useThinkingModel } from "@/components/thinking-model/thinking-model-provider"
import { OPPORTUNITY_STATUS_BADGE } from "@/lib/discovery"
import { entityPath } from "@/lib/entity-links"
import type { LinkedOpportunities } from "@/lib/objective-linked-opportunities"
import type { OpportunityStatus } from "@/lib/types"

const formatScore = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 })

/**
 * The read-only "Linked opportunities" list on the Objective panel. Rows are opportunities linked directly to the objective or through
 * one of its key results, already sorted by the server (raw score descending, unscored last). The score column appears only when the
 * workspace has an active Opportunity scoring model. The table keeps a minimum width and scrolls horizontally inside a height-bounded
 * container (never squashes), so a long list and a narrow panel both stay readable. Entity names come from useLabels(); the generic
 * "Status" / "Score" column headers are plain words (there are no label keys for them). Both link kinds are always listed; the preset's
 * link emphasis only decides which provenance note ("Direct" / "via Key Result") is shown.
 */
export function LinkedOpportunitiesSection({
  data,
  orgSlug,
  workspaceSlug,
}: {
  data: LinkedOpportunities
  orgSlug: string
  workspaceSlug: string
}) {
  const labels = useLabels()
  const links = useThinkingModel().links
  const heading = `Linked ${labels.opportunity.plural}`
  const { items, scoringActive } = data
  return (
    <Section label={heading} count={items.length}>
      <div data-testid="linked-opportunities">
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {labels.opportunity.lowerPlural} linked.</p>
        ) : (
          <div
            role="region"
            aria-label={heading}
            tabIndex={0}
            className="max-h-80 overflow-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-ring"
          >
          <Table
            containerClassName="overflow-visible"
            className={scoringActive ? "min-w-[26rem]" : "min-w-[20rem]"}
          >
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow>
                <TableHead scope="col" className="min-w-[12rem]">{labels.opportunity.singular}</TableHead>
                <TableHead scope="col" className="w-28 min-w-[7rem]">Status</TableHead>
                {scoringActive && <TableHead scope="col" className="w-24 min-w-[5rem] text-right">Score</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const status = OPPORTUNITY_STATUS_BADGE[item.status as OpportunityStatus]
                const showDirect = item.direct && links.oppToObjective !== "hidden"
                const via = links.oppToKr !== "hidden" ? item.viaKeyResults.map((kr) => kr.title).join(", ") : ""
                return (
                  <TableRow key={item.id} data-testid="linked-opportunity-row">
                    <TableCell className="whitespace-normal align-top">
                      <Link
                        href={entityPath({ type: "opportunity", id: item.id, orgSlug, workspaceSlug })}
                        className="font-medium text-foreground hover:underline"
                      >
                        {item.title}
                      </Link>
                      <p className="text-xs text-muted-foreground" data-testid="linked-opportunity-via">
                        {showDirect ? "Direct" : null}
                        {showDirect && via ? " · " : null}
                        {via ? `via ${labels.keyResult.singular}: ${via}` : null}
                      </p>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge className={`${status?.className ?? "bg-surface-inset text-text-secondary"} shrink-0`}>
                        {status?.label ?? item.status}
                      </Badge>
                    </TableCell>
                    {scoringActive && (
                      <TableCell className="text-right align-top tabular-nums" data-testid="linked-opportunity-score">
                        {item.rawScore != null ? (
                          <>
                            <span className="font-semibold text-foreground">{formatScore(item.rawScore)}</span>
                            {item.normalizedScore != null && (
                              <span className="sr-only">{`, normalized ${formatScore(item.normalizedScore)} out of 100`}</span>
                            )}
                            {item.scoreStale && (
                              <div>
                              <Badge
                                data-testid="linked-opportunity-stale"
                                title="Scored under an earlier version of the scoring model; re-score it to compare fairly."
                                className="mt-1 bg-status-warning-surface text-status-warning"
                              >
                                Stale
                              </Badge>
                              </div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Not scored</span>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          </div>
        )}
      </div>
    </Section>
  )
}
