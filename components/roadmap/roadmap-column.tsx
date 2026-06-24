"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { Badge } from "@/components/ui/badge";
import { RoadmapCard, type RoadmapCardData } from "./roadmap-card";
import { AddItemForm } from "./add-item-form";
import type { Horizon } from "@/lib/types";

const HORIZON_CONFIG: Record<Horizon, { label: string; accentClass: string; emptyText: string }> = {
  NOW: {
    label: "Now",
    accentClass: "bg-emerald-500",
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
  workspaceId: string;
  revalidatePathStr: string;
  onItemAdded: (item: RoadmapCardData) => void;
  onArchive: (itemId: string) => void;
};

export function RoadmapColumn({
  horizon,
  items,
  workspaceId,
  revalidatePathStr,
  onItemAdded,
  onArchive,
}: Props) {
  const { label, accentClass, emptyText } = HORIZON_CONFIG[horizon];
  const itemIds = items.map((i) => i.id);

  // Make the column itself a drop target so cards can be dropped into empty columns.
  const { setNodeRef, isOver } = useDroppable({ id: `column-${horizon}`, data: { horizon } });

  return (
    <div className="flex flex-col gap-2 min-w-[300px] flex-1">
      {/* Column header */}
      <div className="flex items-center gap-2 px-1 mb-1">
        <div className={`w-2 h-2 rounded-full shrink-0 ${accentClass}`} aria-hidden="true" />
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <span className="ml-auto text-xs font-medium text-slate-400 bg-slate-200/60 rounded-full px-2 py-0.5 tabular-nums">
          {items.length}
        </span>
      </div>

      {/* Drop zone / card list */}
      <div
        ref={setNodeRef}
        className={[
          "flex flex-col gap-2 min-h-[180px] rounded-xl p-2.5 transition-colors",
          isOver
            ? "bg-indigo-50/80 ring-2 ring-inset ring-indigo-200"
            : "bg-slate-100/80",
        ].join(" ")}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {items.length === 0 ? (
            <div
              className={[
                "flex items-center justify-center flex-1 min-h-[120px] rounded-lg border border-dashed py-8 text-xs text-center text-slate-400 px-4 transition-colors",
                isOver ? "border-indigo-300" : "border-slate-300/70",
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

      {/* Inline add form at column bottom */}
      <AddItemForm
        workspaceId={workspaceId}
        horizon={horizon}
        revalidatePathStr={revalidatePathStr}
        onAdd={onItemAdded}
      />
    </div>
  );
}
