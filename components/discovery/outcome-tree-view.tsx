"use client"

import { useState } from "react"
import type { OutcomeRoot, OutcomeTree, SolutionNode } from "@/lib/thinking-model/outcome-tree"
import { usePanelContext } from "@/components/panels/panel-context"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { EmptyState } from "@/components/patterns"

/**
 * The workspace-level tree for the TORRES_OST and OPPORTUNITY_FIRST_OKR presets.
 *
 * Presentation only: the tree arrives already derived (lib/thinking-model/outcome-tree.ts)
 * and every entity word comes from useLabels(), so a workspace that renames Objective
 * sees its own word here. CLASSIC never renders this component (the route 404s and the
 * entry link is not shown).
 *
 * Layout notes: the metric strip scrolls horizontally rather than squashing, and an
 * Opportunity linked to several Objectives shows its subtree once, with expandable stubs
 * elsewhere (the stub reads the same subtree, so nothing is duplicated in the data).
 */

const plural = (count: number, label: { lower: string; lowerPlural: string }) =>
  `${count} ${count === 1 ? label.lower : label.lowerPlural}`

const statusText = (status: string) => status.toLowerCase().replace(/_/g, " ")

const chipClass =
  "inline-flex max-w-full items-center rounded-full border border-border-default bg-surface-inset px-2 py-0.5 text-xs text-text-secondary"
const linkButtonClass =
  "min-w-0 break-words text-left font-medium text-text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"

export function OutcomeTreeView({ tree }: { tree: OutcomeTree }) {
  const labels = useLabels()
  const { openPanel } = usePanelContext()
  const [expandedStubs, setExpandedStubs] = useState<ReadonlySet<string>>(new Set())

  const toggleStub = (key: string) =>
    setExpandedStubs((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (tree.roots.length === 0 && tree.pool.length === 0) {
    return (
      <>
        <EmptyState
        title={`No ${labels.objective.lowerPlural} or ${labels.opportunity.lowerPlural} yet`}
        description={`Add ${labels.objective.indefinite} and link ${labels.opportunity.lowerPlural} to it to grow the tree.`}
        />
      </>
    )
  }

  const solutionRow = (solution: SolutionNode) => (
    <li key={solution.id} data-testid={`outcome-solution-${solution.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <button type="button" className={linkButtonClass} onClick={() => openPanel("solution", solution.id)}>
        {solution.title}
      </button>
      <span className="text-xs text-text-subtle">{statusText(solution.status)}</span>
      {solution.krChips.map((chip) => (
        <span
          key={chip.keyResultId}
          data-testid={`outcome-kr-chip-${solution.id}-${chip.keyResultId}`}
          data-cross-outcome={chip.crossOutcome ? "true" : "false"}
          className={chipClass}
          title={chip.crossOutcome ? `Under ${chip.objectiveTitle}, not linked from this ${labels.opportunity.lower}` : undefined}
        >
          {chip.title}
          {chip.crossOutcome ? ` · ${chip.objectiveTitle}` : ""}
        </span>
      ))}
    </li>
  )

  const opportunityBody = (opportunityId: string) => {
    const node = tree.opportunities[opportunityId]
    if (!node) return null
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <button type="button" className={linkButtonClass} onClick={() => openPanel("opportunity", node.id)}>
            {node.title}
          </button>
          <span className="text-xs text-text-subtle">{statusText(node.status)}</span>
        </div>
        {node.solutionIds.length > 0 && (
          <ul className="ml-3 flex flex-col gap-1.5 border-l border-border-default pl-3">
            {node.solutionIds.map((id) => tree.solutions[id] && solutionRow(tree.solutions[id]))}
          </ul>
        )}
      </div>
    )
  }

  const metricStrip = (root: OutcomeRoot) =>
    root.keyResults.length > 0 && (
      <div data-testid={`outcome-metrics-${root.id}`} className="flex flex-col gap-1">
        <p className="text-xs font-medium text-text-subtle">{labels.keyResult.plural}</p>
        <ul className="flex gap-2 overflow-x-auto pb-1">
          {root.keyResults.map((kr) => (
            <li key={kr.id} className="flex min-w-[12rem] shrink-0 flex-col gap-1 rounded-lg border border-border-default bg-surface-inset px-3 py-2">
              <button type="button" className={`${linkButtonClass} text-xs`} onClick={() => openPanel("keyResult", kr.id)}>
                {kr.title}
              </button>
              {kr.progress !== null && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary" style={{ width: `${Math.round(kr.progress * 100)}%` }} />
                </div>
              )}
              <span className="text-xs tabular-nums text-text-subtle">
                {kr.current}/{kr.target}
                {kr.unit ? ` ${kr.unit}` : ""}
              </span>
              {tree.shape === "objective-rooted-pool" && kr.solutionIds.length > 0 && (
                <ul className="flex flex-col gap-1 border-t border-border-default pt-1.5">
                  {kr.solutionIds.map((id) => tree.solutions[id] && solutionRow(tree.solutions[id]))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    )

  const rootCard = (root: OutcomeRoot) => (
    <section
      key={root.id}
      data-testid={`outcome-root-${root.id}`}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border-default bg-surface-panel p-4"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="min-w-0 text-base font-semibold text-text-primary">
          <button type="button" className={linkButtonClass} onClick={() => openPanel("objective", root.id)}>
            {root.title}
          </button>
        </h2>
        {root.cycle && (
          <span data-testid={`outcome-cycle-${root.id}`} className={chipClass}>
            {root.cycle.title}
          </span>
        )}
        {root.supports && (
          <span data-testid={`outcome-supports-${root.id}`} className={chipClass}>
            Supports {root.supports.objectiveTitle}
          </span>
        )}
        <span className="text-xs text-text-subtle">
          {plural(root.rollup.opportunities, labels.opportunity)} · {plural(root.rollup.solutions, labels.solution)}
          {root.linkedOpportunityCount > root.rollup.opportunities &&
            ` · +${root.linkedOpportunityCount - root.rollup.opportunities} also under other ${labels.objective.lowerPlural}`}
        </span>
      </header>

      {metricStrip(root)}

      {root.children.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {root.children.map((child) => {
            if (child.placement === "home") {
              return (
                <li key={child.opportunityId} data-testid={`outcome-opportunity-${root.id}-${child.opportunityId}`}>
                  {opportunityBody(child.opportunityId)}
                </li>
              )
            }
            const key = `${root.id}:${child.opportunityId}`
            const open = expandedStubs.has(key)
            const node = tree.opportunities[child.opportunityId]
            return (
              <li key={child.opportunityId} data-testid={`outcome-stub-${root.id}-${child.opportunityId}`} className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-text-secondary">{node?.title}</span>
                  <span className={chipClass}>Also under {child.homeObjective?.title}</span>
                  <button
                    type="button"
                    className="text-xs text-text-subtle underline underline-offset-2 hover:text-text-primary"
                    aria-expanded={open}
                    onClick={() => toggleStub(key)}
                  >
                    {open ? "Hide" : "Show"}
                  </button>
                </div>
                {open && <div className="ml-3 border-l border-border-default pl-3">{opportunityBody(child.opportunityId)}</div>}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-sm text-text-subtle">No {labels.opportunity.lowerPlural} linked yet.</p>
      )}

      {tree.shape === "objective-rooted-pool" && root.looseSolutionIds.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-text-subtle">
            {labels.solution.plural} not aimed at {labels.keyResult.indefinite}
          </p>
          <ul className="flex flex-col gap-1.5">{root.looseSolutionIds.map((id) => tree.solutions[id] && solutionRow(tree.solutions[id]))}</ul>
        </div>
      )}
    </section>
  )

  const pool = tree.pool.length > 0 && (
    <section data-testid="outcome-pool" className="flex min-w-0 flex-col gap-3 rounded-xl border border-dashed border-border-strong bg-surface-inset p-4">
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-base font-semibold text-text-primary">
          {labels.opportunity.plural} not linked to {labels.objective.lowerPlural}
        </h2>
        <span className="text-xs text-text-subtle">{tree.pool.length}</span>
      </header>
      <ul className="flex flex-col gap-3">
        {tree.pool.map((id) => (
          <li key={id} data-testid={`outcome-pool-opportunity-${id}`}>
            {opportunityBody(id)}
          </li>
        ))}
      </ul>
    </section>
  )

  return (
    <div data-testid="outcome-tree" data-shape={tree.shape} className="flex min-w-0 flex-col gap-4">
      {tree.shape === "objective-rooted-pool" && pool}
      {tree.roots.map(rootCard)}
      {tree.shape === "outcome-rooted" && pool}
    </div>
  )
}
