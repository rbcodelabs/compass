"use client"

import { usePanelContext } from "@/components/panels/panel-context"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { STATUS_BADGE } from "@/lib/okrs"
import type { ObjectiveStatus } from "@/lib/types"

/**
 * The flat index of Objectives for the TORRES_OST preset ("Outcomes"): every one the
 * workspace has, reachable without choosing a cycle first. A cycle chip appears only
 * where an Objective actually has a cycle; nothing here requires or promotes one.
 *
 * Presentation only. Rows come from the same derivation as the tree
 * (lib/thinking-model/outcome-tree.ts), so the linked counts agree with it.
 */
export type OutcomesIndexRow = {
  id: string
  title: string
  status: string | null
  cycle: { id: string; title: string } | null
  linkedOpportunityCount: number
}

export function OutcomesIndex({ rows, linksUnavailable = false }: { rows: OutcomesIndexRow[]; linksUnavailable?: boolean }) {
  const labels = useLabels()
  const { openPanel } = usePanelContext()
  if (rows.length === 0) return null

  return (
    <section data-testid="outcomes-index" aria-label={`All ${labels.objective.lowerPlural}`} className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-text-primary">All {labels.objective.lowerPlural}</h2>
      {linksUnavailable && (
        <p
          role="status"
          data-testid="outcomes-index-links-unavailable"
          className="rounded-lg border border-status-warning bg-status-warning-surface px-3 py-2 text-xs text-status-warning"
        >
          Link data is unavailable right now, so counts may be incomplete.
        </p>
      )}
      <ul className="flex flex-col divide-y divide-border-default rounded-xl border border-border-default bg-surface-panel">
        {rows.map((row) => {
          const badge = row.status ? STATUS_BADGE[row.status as ObjectiveStatus] : undefined
          return (
            <li key={row.id} data-testid={`outcomes-index-row-${row.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <button
                type="button"
                className="min-w-0 break-words text-left text-sm font-medium text-text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                onClick={() => openPanel("objective", row.id)}
              >
                {row.title}
              </button>
              {badge && <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>}
              {row.cycle && (
                <span data-testid={`outcomes-index-cycle-${row.id}`} className="inline-flex items-center rounded-full border border-border-default bg-surface-inset px-2 py-0.5 text-xs text-text-secondary">
                  {row.cycle.title}
                </span>
              )}
              <span className="text-xs text-text-subtle">
                {row.linkedOpportunityCount} linked {row.linkedOpportunityCount === 1 ? labels.opportunity.lower : labels.opportunity.lowerPlural}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
