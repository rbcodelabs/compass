"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { solutionFieldGroupByValue, type SolutionGroupBy } from "@/lib/solution-backlog-grouping";

export type SolutionGroupByFieldOption = { id: string; label: string };

/**
 * The Solutions backlog's grouping picker: Status (default, omitted from the
 * URL), Squad, parent Opportunity, plus one entry per groupable Solution
 * single-select field (`groupBy=field:<id>`). A `Select` rather than tabs
 * because the field count is workspace-defined.
 */
export function SolutionGroupByToggle({
  groupBy,
  fieldOptions = [],
}: {
  groupBy: SolutionGroupBy;
  fieldOptions?: SolutionGroupByFieldOption[];
}) {
  const { set } = useUrlState();
  const labels = useLabels();

  return (
    <Select
      value={groupBy}
      onValueChange={(next) => set({ groupBy: !next || next === "status" ? null : String(next) })}
    >
      <SelectTrigger aria-label="Group board by">
        <span className="text-muted-foreground">Group by:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="status">Status</SelectItem>
        <SelectItem value="squad">Squad</SelectItem>
        <SelectItem value="opportunity">{labels.opportunity.singular}</SelectItem>
        {fieldOptions.map((option) => (
          <SelectItem key={option.id} value={solutionFieldGroupByValue(option.id)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
