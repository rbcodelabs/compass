"use client";

import { useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { assignSquad } from "@/app/[orgSlug]/[workspaceSlug]/settings/actions";
import type { SquadData } from "@/lib/types";

interface Props {
  objectType: "objective" | "opportunity" | "experiment" | "roadmapItem";
  objectId: string;
  currentSquadId: string | null;
  squads: SquadData[];
  revalidatePathStr: string;
}

export function SquadPicker({
  objectType,
  objectId,
  currentSquadId,
  squads,
  revalidatePathStr,
}: Props) {
  const [isPending, startTransition] = useTransition();

  if (squads.length === 0) return null;

  function handleChange(value: string | null) {
    if (!value) return;
    const squadId = value === "__none__" ? null : value;
    startTransition(async () => {
      await assignSquad(objectType, objectId, squadId, revalidatePathStr);
    });
  }

  const activeSquad = squads.find((s) => s.id === currentSquadId);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Squad</span>
      <Select
        value={currentSquadId ?? "__none__"}
        onValueChange={handleChange}
        disabled={isPending}
      >
        <SelectTrigger className="h-7 text-xs w-auto min-w-[140px] gap-1.5">
          {activeSquad ? (
            <span className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: activeSquad.color }}
              />
              <SelectValue />
            </span>
          ) : (
            <SelectValue placeholder="No squad" />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">
            <span className="text-muted-foreground">No squad</span>
          </SelectItem>
          {squads.map((squad) => (
            <SelectItem key={squad.id} value={squad.id}>
              <span className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full shrink-0 inline-block"
                  style={{ backgroundColor: squad.color }}
                />
                {squad.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
