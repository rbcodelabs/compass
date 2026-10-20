"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * The OKR page's grouping picker, rendered in the PageHeader actions like
 * Discovery's and Roadmap's. "None" is the default and is omitted from the URL.
 */
export function OkrGroupByToggle({
  groupBy,
  fieldOptions,
}: {
  groupBy: string;
  fieldOptions: Array<{ id: string; label: string }>;
}) {
  const { set } = useUrlState();

  return (
    <Select value={groupBy} onValueChange={(next) => set({ groupBy: !next || next === "none" ? null : String(next) })}>
      <SelectTrigger aria-label="Group by">
        <span className="text-muted-foreground">Group by:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">None</SelectItem>
        {fieldOptions.map((o) => (
          <SelectItem key={o.id} value={`field:${o.id}`}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
