"use client"

import { Rows3 } from "lucide-react"
import { useUrlState } from "@/hooks/use-url-state"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type RoadmapGroupByFieldOption = { id: string; label: string }

/**
 * The roadmap's grouping picker — Phase (default) / Squad / None on the timeline, no swimlanes (default) / Squad on
 * the board, plus one entry per groupable (SELECT-type ROADMAP_ITEM) custom field.
 *
 * Icon-only to save header space: the trigger is a rows icon with the accessible name "Group board by" /
 * "Group timeline by". A tooltip names the current mode ("Swimlanes: Squad", "No swimlanes", "Group by: Phase"), and
 * a small dot on the icon says a non-default grouping is active. The dropdown lists the options as text.
 *
 * A `Select` dropdown rather than `Tabs` (contrast
 * components/discovery/discovery-group-by-toggle.tsx), because the option
 * count is dynamic — the built-ins plus however many custom fields the
 * workspace has defined.
 */
export function RoadmapGroupByToggle({ value, customFieldOptions, variant = "timeline" }: {
  /** "timeline" groups rows (Phase default); "board" groups swimlanes (no lanes default). */
  variant?: "timeline" | "board";
  /** "phase" | "squad" | "none" | a groupable CustomFieldDefinition id. */
  value: string;
  customFieldOptions: RoadmapGroupByFieldOption[];
}) {
  const { set } = useUrlState()
  const isBoard = variant === "board"
  // On the board, Phase and None are the same thing: no swimlanes. "phase" is the
  // URL default (param omitted), so it doubles as the board's "None" item.
  const selected = isBoard && value === "none" ? "phase" : value

  const optionLabel =
    selected === "squad" ? "Squad"
    : selected === "none" ? "None"
    : selected === "phase" ? "Phase"
    : (customFieldOptions.find((option) => option.id === selected)?.label ?? selected)
  const tooltip = isBoard
    ? (selected === "phase" ? "No swimlanes" : `Swimlanes: ${optionLabel}`)
    : `Group by: ${optionLabel}`
  // The default is the first item: no swimlanes on the board, Phase on the timeline.
  const active = selected !== "phase"

  return (
    <Select value={selected} onValueChange={(next) => set({ groupBy: next === "phase" ? null : next })}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              aria-label={isBoard ? "Group board by" : "Group timeline by"}
              data-slot="roadmap-group-by-trigger"
              data-active={active ? "true" : undefined}
              // Icon only: square, centred, and no chevron (the tooltip and the dot carry the state).
              className="w-8 justify-center px-0 [&>svg:last-child]:hidden"
            />
          }
        >
          <span className="relative inline-flex">
            <Rows3 aria-hidden />
            {active ? (
              <span
                aria-hidden
                data-testid="group-by-active-dot"
                className="absolute -top-1 -right-1 size-2 rounded-full bg-primary ring-2 ring-background"
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>
      <SelectContent alignItemWithTrigger={false} align="end">
        {isBoard ? (
          <SelectItem value="phase">No swimlanes</SelectItem>
        ) : (
          <SelectItem value="phase">Phase</SelectItem>
        )}
        <SelectItem value="squad">Squad</SelectItem>
        {!isBoard && <SelectItem value="none">None</SelectItem>}
        {customFieldOptions.map((option) => (
          <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
