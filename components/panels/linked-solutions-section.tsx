"use client"

import { Section, RelationList, type RelationItem } from "./panel-parts"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"

/**
 * The read-only "Linked solutions" list on the Key Result panel (Phase 4B). Links are authored from the Solution
 * panel; this is where the other end sees them, each row opening that solution's panel. The caller shows it only
 * for presets that offer the Solution <-> Key Result link. Every name comes from useLabels().
 */
export function LinkedSolutionsSection({
  solutions,
  linksUnavailable = false,
}: {
  solutions: Array<{ id: string; title: string }>
  /** The link table could not be read, so an empty list must not read as "none". */
  linksUnavailable?: boolean
}) {
  const labels = useLabels()
  const items: RelationItem[] = solutions.map((solution) => ({ type: "solution", id: solution.id, title: solution.title }))
  return (
    <Section label={`Linked ${labels.solution.plural}`} count={solutions.length}>
      <div data-testid="linked-solutions" className="flex flex-col gap-2">
        {linksUnavailable ? (
          <p role="status" data-testid="linked-solutions-unavailable" className="text-sm text-muted-foreground">
            Link data is unavailable right now, so this list may be incomplete.
          </p>
        ) : (
          <RelationList items={items} empty={`No ${labels.solution.lowerPlural} linked.`} />
        )}
      </div>
    </Section>
  )
}
