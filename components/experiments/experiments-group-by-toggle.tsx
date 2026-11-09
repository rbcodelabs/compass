"use client";

import { Rows3 } from "lucide-react";
import { useUrlState } from "@/hooks/use-url-state";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ExperimentGalleryGroupMode } from "@/lib/experiments/gallery";

const OPTIONS: { value: ExperimentGalleryGroupMode; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "squad", label: "Squad" },
  { value: "conclusion", label: "Conclusion" },
  { value: "none", label: "None" },
];

/**
 * The Experiments Gallery's grouping picker. Icon-only like the roadmap's (header space is tight), named
 * "Group gallery by", with a tooltip for the current mode and a dot when it is not the default (Status,
 * which is the absence of the `groupBy` param).
 */
export function ExperimentsGroupByToggle({ value }: { value: ExperimentGalleryGroupMode }) {
  const { set } = useUrlState();
  const active = value !== "status";
  const current = OPTIONS.find((option) => option.value === value)?.label ?? "Status";

  return (
    <Select value={value} onValueChange={(next) => set({ groupBy: next === "status" ? null : next })}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              aria-label="Group gallery by"
              data-slot="experiments-group-by-trigger"
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
        <TooltipContent side="bottom">{`Group by: ${current}`}</TooltipContent>
      </Tooltip>
      <SelectContent alignItemWithTrigger={false} align="end">
        {OPTIONS.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
