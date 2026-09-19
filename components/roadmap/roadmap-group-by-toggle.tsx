"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type RoadmapGroupByFieldOption = { id: string; label: string };

/**
 * The roadmap timeline's grouping picker — Phase (default) / Squad / None,
 * plus one entry per groupable (SELECT-type ROADMAP_ITEM) custom field.
 *
 * A `Select` dropdown rather than `Tabs` (contrast
 * components/discovery/discovery-group-by-toggle.tsx), because the option
 * count is dynamic — three built-ins plus however many custom fields the
 * workspace has defined.
 */
export function RoadmapGroupByToggle({ value, customFieldOptions }: {
  /** "phase" | "squad" | "none" | a groupable CustomFieldDefinition id. */
  value: string;
  customFieldOptions: RoadmapGroupByFieldOption[];
}) {
  const { set } = useUrlState();

  return (
    <Select value={value} onValueChange={(next) => set({ groupBy: next === "phase" ? null : next })}>
      <SelectTrigger aria-label="Group timeline by">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="phase">Phase</SelectItem>
        <SelectItem value="squad">Squad</SelectItem>
        <SelectItem value="none">None</SelectItem>
        {customFieldOptions.map((option) => (
          <SelectItem key={option.id} value={option.id}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
