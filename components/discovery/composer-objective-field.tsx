"use client"

import { useMemo } from "react"
import { X } from "lucide-react"
import { ComboboxContent, ComboboxMultiple, ComboboxTrigger, type ComboboxItemData } from "@/components/ui/combobox"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { OPPORTUNITY_LINK_OBJECTIVES_MAX } from "@/lib/opportunity-draft"

/**
 * The optional Objective multi-select in the "New opportunity" composer (Phase 4B). Shown only by presets that make the
 * Opportunity <-> Objective link primary; the composer decides, this component just renders. The chosen ids are sent with the
 * create and linked in the same transaction as the opportunity row. Every name comes from useLabels().
 */
export type ComposerObjectiveOption = { id: string; title: string; cycleTitle?: string | null }

export function ComposerObjectiveField({
  id,
  objectives,
  value,
  onChange,
  disabled,
}: {
  id: string
  objectives: ComposerObjectiveOption[]
  value: string[]
  onChange: (value: string[]) => void
  disabled: boolean
}) {
  const labels = useLabels()
  const items = useMemo<ComboboxItemData[]>(() => objectives.map((o) => ({ value: o.id, label: o.title })), [objectives])
  const byId = useMemo(() => new Map(objectives.map((o) => [o.id, o])), [objectives])
  const selected = value.map((objectiveId) => byId.get(objectiveId)).filter((o) => o !== undefined)

  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5" data-testid="composer-objective-field">
      <span id={id} className="text-xs font-medium text-text-secondary">
        {labels.objective.plural} <span className="font-normal text-text-subtle">· optional</span>
      </span>
      {objectives.length === 0 ? (
        <p className="text-xs text-text-subtle">No {labels.objective.lowerPlural} in this workspace yet.</p>
      ) : (
        <>
          <ComboboxMultiple
            items={items}
            values={value}
            // The server refuses more than this; stop the picker at the same place.
            onValuesChange={(next) => onChange(next.slice(0, OPPORTUNITY_LINK_OBJECTIVES_MAX))}
            disabled={disabled}
          >
            <ComboboxTrigger aria-label={labels.objective.plural} className="w-full">
              <span className="flex-1 text-left text-muted-foreground">
                {value.length ? `${value.length} selected, add more` : `Link ${labels.objective.lowerPlural}`}
              </span>
            </ComboboxTrigger>
            <ComboboxContent
              align="start"
              inputPlaceholder={`Search ${labels.objective.lowerPlural}…`}
              emptyMessage={`No matching ${labels.objective.lowerPlural}.`}
            />
          </ComboboxMultiple>
          {selected.length > 0 && (
            <ul aria-label={`Selected ${labels.objective.lowerPlural}`} className="flex flex-col gap-1">
              {selected.map((objective) => (
                <li
                  key={objective.id}
                  className="flex items-center gap-2 rounded-md border border-border-default bg-surface-card py-1 pr-1 pl-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate text-text-primary" title={objective.title}>
                    {objective.title}
                  </span>
                  {objective.cycleTitle && <span className="shrink-0 text-xs text-text-subtle">{objective.cycleTitle}</span>}
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((objectiveId) => objectiveId !== objective.id))}
                    disabled={disabled}
                    aria-label={`Remove ${objective.title}`}
                    className="shrink-0 rounded p-0.5 text-text-subtle transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <X aria-hidden className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}
