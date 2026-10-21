"use client";

import { useUrlState } from "@/hooks/use-url-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SquadData } from "@/lib/types";

interface Props {
  squads: SquadData[];
}

/** Squad filter as a compact header Select (same pattern as the Group by picker). */
export function SquadFilterBar({ squads }: Props) {
  const { params, set } = useUrlState();
  const active = params.get("squad") ?? "all";

  if (squads.length === 0) return null;

  return (
    <Select value={active} onValueChange={(next) => set({ squad: !next || next === "all" ? null : String(next) })}>
      <SelectTrigger aria-label="Filter by squad">
        <span className="text-muted-foreground">Squad:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All</SelectItem>
        {squads.map((squad) => (
          <SelectItem key={squad.id} value={squad.id}>
            {squad.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
