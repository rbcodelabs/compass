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
export function RoadmapGroupByToggle({ value, customFieldOptions, variant = "timeline" }: {
  /** "timeline" groups rows (Phase default); "board" groups swimlanes (no lanes default). */
  variant?: "timeline" | "board";
  /** "phase" | "squad" | "none" | a groupable CustomFieldDefinition id. */
  value: string;
  customFieldOptions: RoadmapGroupByFieldOption[];
}) {
  const { set } = useUrlState();
  const isBoard = variant === "board";
  // On the board, Phase and None are the same thing: no swimlanes. "phase" is the
  // URL default (param omitted), so it doubles as the board's "None" item.
  const selected = isBoard && value === "none" ? "phase" : value;

  return (
    <Select value={selected} onValueChange={(next) => set({ groupBy: next === "phase" ? null : next })}>
      <SelectTrigger aria-label={isBoard ? "Group board by" : "Group timeline by"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
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
  );
}
