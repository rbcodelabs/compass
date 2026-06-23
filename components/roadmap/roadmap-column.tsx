"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RoadmapCard, type RoadmapCardData } from "./roadmap-card";
import type { Horizon } from "@/lib/types";

const HORIZON_CONFIG: Record<Horizon, { label: string; accentClass: string; emptyText: string }> = {
  NOW: {
    label: "Now",
    accentClass: "bg-green-500",
    emptyText: "What are you shipping right now?",
  },
  NEXT: {
    label: "Next",
    accentClass: "bg-blue-500",
    emptyText: "What's coming up after the current work?",
  },
  LATER: {
    label: "Later",
    accentClass: "bg-slate-400",
    emptyText: "Ideas and things on the horizon.",
  },
};

type Props = {
  horizon: Horizon;
  items: RoadmapCardData[];
  revalidatePathStr: string;
  onAdd: (horizon: Horizon) => void;
  onArchive: (itemId: string) => void;
};

export function RoadmapColumn({
  horizon,
  items,
  revalidatePathStr,
  onAdd,
  onArchive,
}: Props) {
  const { label, accentClass, emptyText } = HORIZON_CONFIG[horizon];
  const itemIds = items.map((i) => i.id);

  // Make the column itself a drop target so cards can be dropped into empty columns.
  const { setNodeRef, isOver } = useDroppable({ id: `column-${horizon}`, data: { horizon } });

  return (
    <div className="flex flex-col gap-3 min-w-[300px] flex-1">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${accentClass}`} aria-hidden="true" />
        <span className="text-sm font-semibold tracking-wide">{label}</span>
        <Badge variant="secondary" className="text-xs tabular-nums">
          {items.length}
        </Badge>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-muted-foreground hover:text-foreground"
          onClick={() => onAdd(horizon)}
          aria-label={`Add item to ${label}`}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>

      {/* Drop zone / card list */}
      <div
        ref={setNodeRef}
        className={[
          "flex flex-col gap-2 min-h-[120px] rounded-xl p-2 transition-colors",
          isOver
            ? "bg-muted/60 ring-2 ring-inset ring-foreground/10"
            : "bg-muted/30",
        ].join(" ")}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            <div
              className={[
                "flex items-center justify-center flex-1 rounded-lg border border-dashed py-8 text-xs text-center text-muted-foreground px-4 transition-colors",
                isOver ? "border-foreground/20" : "border-border/60",
              ].join(" ")}
            >
              {emptyText}
            </div>
          ) : (
            items.map((item) => (
              <RoadmapCard
                key={item.id}
                item={item}
                revalidatePathStr={revalidatePathStr}
                onArchive={onArchive}
              />
            ))
          )}
        </SortableContext>
      </div>
    </div>
  );
}
