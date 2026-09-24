"use client";

import { useState, useTransition } from "react";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { assignSquad } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { SquadData } from "@/lib/types";

interface Props {
  objectType: "objective" | "opportunity" | "experiment" | "roadmapItem" | "task";
  objectId: string;
  currentSquadId: string | null;
  squads: SquadData[];
  revalidatePathStr: string;
  onChanged?: () => void;
  onAssign?: (squadId: string | null) => Promise<void>;
}

export function SquadPicker({
  objectType,
  objectId,
  currentSquadId,
  squads,
  revalidatePathStr,
  onChanged,
  onAssign,
}: Props) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (squads.length === 0) return null;

  function handleChange(value: string | null) {
    if (!value) return;
    const squadId = value === "__none__" ? null : value;
    startTransition(async () => {
      setError(null);
      try {
        if (onAssign) await onAssign(squadId);
        else await assignSquad(objectType, objectId, squadId, revalidatePathStr);
        onChanged?.();
      } catch (err) { setError(err instanceof Error ? err.message : "Could not assign squad."); }
    });
  }

  const activeSquad = squads.find((s) => s.id === currentSquadId);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {error && <p role="alert" className="w-full text-xs text-destructive">{error}</p>}
      <span className="text-xs text-muted-foreground">Squad</span>
      <Combobox
        items={[
          {
            value: "__none__",
            label: "No squad",
            render: <span className="text-muted-foreground">No squad</span>,
          },
          ...squads.map((squad) => ({
            value: squad.id,
            label: squad.name,
            render: (
              <span className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full shrink-0 inline-block"
                  style={{ backgroundColor: squad.color }}
                />
                {squad.name}
              </span>
            ),
          })),
        ]}
        value={currentSquadId ?? "__none__"}
        onValueChange={handleChange}
        disabled={isPending}
      >
        <ComboboxTrigger className="h-7 text-xs w-auto min-w-[140px] gap-1.5">
          {activeSquad ? (
            <span className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: activeSquad.color }}
              />
              <ComboboxValue />
            </span>
          ) : (
            <ComboboxValue placeholder="No squad" />
          )}
        </ComboboxTrigger>
        <ComboboxContent />
      </Combobox>
    </div>
  );
}
