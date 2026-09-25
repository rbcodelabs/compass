"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fieldGroupByValue, type DiscoveryGroupBy } from "@/lib/opportunity-field-board";

export type { DiscoveryGroupBy };

export type DiscoveryGroupByFieldOption = { id: string; label: string };

/**
 * The Discovery board's grouping picker: Status (default, omitted from the
 * URL), Opportunity (solution swimlanes), plus one entry per groupable
 * Opportunity single-select field (`groupBy=field:<id>`). A compact `Select`
 * rather than tabs because the field count is workspace-defined — the same
 * reasoning as components/roadmap/roadmap-group-by-toggle.tsx.
 */
export function DiscoveryGroupByToggle({
  groupBy,
  fieldOptions = [],
}: {
  groupBy: DiscoveryGroupBy;
  fieldOptions?: DiscoveryGroupByFieldOption[];
}) {
  const { set } = useUrlState();

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
        <SelectItem value="opportunity">Opportunity</SelectItem>
        {fieldOptions.map((option) => (
          <SelectItem key={option.id} value={fieldGroupByValue(option.id)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
