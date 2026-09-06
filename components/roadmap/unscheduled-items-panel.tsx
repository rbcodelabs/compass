"use client";

import * as React from "react";
import { useDraggable } from "@dnd-kit/core";
import { GripVertical, Layers, Bug } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { CardMenu } from "@/components/ui/card-menu";
import { Badge } from "@/components/ui/badge";
import { BoardColumn, EmptyState } from "@/components/patterns";
import { HORIZON_META, QUICK_ADD_HORIZONS } from "@/lib/roadmap";
import type { Horizon } from "@/lib/types";

// A candidate item that could be scheduled onto the roadmap but isn't yet:
// a validated/in-delivery Solution from Discovery, or a Bug-type Feedback
// item. Both already have a "Promote to roadmap" entry point elsewhere in
// the app (Discovery solution cards, the Feedback board) — this panel is a
// second, roadmap-centric entry point into the same underlying actions.
export type UnscheduledItem =
  | {
      kind: "solution";
      id: string;
      title: string;
      opportunityId: string;
      opportunityTitle: string;
      squadId: string | null;
    }
  | {
      kind: "feedback";
      id: string;
      title: string;
    };

// dnd-kit drag ids share one flat namespace with existing RoadmapItem card
// ids in the same DndContext, so unscheduled items need a distinguishable
// prefix — handleDragStart/handleDragEnd check for this prefix before
// falling back to the "reorder an existing card" logic.
export function unscheduledDragId(item: UnscheduledItem): string {
  return `unscheduled:${item.kind}:${item.id}`;
}

export function parseUnscheduledDragId(
  dragId: string
): { kind: "solution" | "feedback"; id: string } | null {
  const match = /^unscheduled:(solution|feedback):(.+)$/.exec(dragId);
  if (!match) return null;
  return { kind: match[1] as "solution" | "feedback", id: match[2] };
}

const HORIZON_LABELS: Record<Horizon, string> = Object.fromEntries(
  Object.entries(HORIZON_META).map(([h, m]) => [h, m.label])
) as Record<Horizon, string>;
// QUICK_ADD_HORIZONS (NOW/NEXT/LATER) deliberately omits Shipped and the
// launch horizons — promoting straight there without planning doesn't match
// how those horizons are used.

type Props = {
  items: UnscheduledItem[];
  onQuickAdd: (item: UnscheduledItem, horizon: Horizon) => void;
};

export function UnscheduledItemsPanel({ items, onQuickAdd }: Props) {
  if (items.length === 0) return null;

  return (
    <div id="unscheduled-items-panel" className="rounded-xl ring-1 ring-border bg-muted/30 p-3 sm:p-4 shrink-0">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-sm font-semibold text-slate-700">Not yet on the roadmap</h2>
        <span className="text-xs font-medium text-slate-400 bg-slate-200/60 rounded-full px-2 py-0.5 tabular-nums">
          {items.length}
        </span>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Drag an item onto a horizon (or the timeline) to schedule it, or use its menu.
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <UnscheduledItemCard key={unscheduledDragId(item)} item={item} onQuickAdd={onQuickAdd} />
        ))}
      </div>
    </div>
  );
}

export function UnscheduledItemsColumn({ items, onQuickAdd }: Props) {
  return (
    <BoardColumn
      title="Not scheduled"
      count={items.length}
      accent="neutral"
      data-testid="roadmap-unscheduled-column"
      className="min-w-[280px] flex-1 overflow-hidden md:h-full"
      bodyId="unscheduled-items-column"
      bodyClassName="min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto"
    >
      {items.length === 0 ? (
        <EmptyState compact title="No items waiting to be scheduled." />
      ) : (
        items.map((item) => (
          <UnscheduledItemCard
            key={unscheduledDragId(item)}
            item={item}
            onQuickAdd={onQuickAdd}
            fullWidth
          />
        ))
      )}
    </BoardColumn>
  );
}

function UnscheduledItemCard({
  item,
  onQuickAdd,
  fullWidth = false,
}: {
  item: UnscheduledItem;
  onQuickAdd: Props["onQuickAdd"];
  fullWidth?: boolean;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, isDragging } = useDraggable({
    id: unscheduledDragId(item),
    data: { unscheduledItem: item },
  });

  const style: React.CSSProperties = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 50 }
    : {};

  return (
    <div ref={setNodeRef} style={style} className={fullWidth ? "touch-none w-full" : "touch-none w-56"}>
      <Card
        size="sm"
        className="w-full bg-white shadow-sm transition-opacity duration-150 data-[dragging=true]:opacity-40"
        data-dragging={isDragging ? true : undefined}
      >
        <CardHeader className="flex-row items-start gap-2 pr-2">
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label="Drag to schedule"
          >
            <GripVertical className="size-3.5" />
          </button>

          <CardTitle className="flex-1 text-sm leading-snug">{item.title}</CardTitle>

          <CardMenu
            items={QUICK_ADD_HORIZONS.map((h) => ({
              label: `Add to ${HORIZON_LABELS[h]}`,
              onClick: () => onQuickAdd(item, h),
            }))}
          />
        </CardHeader>

        <UnscheduledItemBody item={item} />
      </Card>
    </div>
  );
}

function UnscheduledItemBody({ item }: { item: UnscheduledItem }) {
  return (
    <CardContent className="flex flex-col gap-1.5 pt-0">
      {item.kind === "solution" ? (
        <>
          <Badge variant="outline" className="gap-1 w-fit">
            <Layers className="size-3" />
            Solution
          </Badge>
          <p className="text-[11px] text-muted-foreground/70 truncate">{item.opportunityTitle}</p>
        </>
      ) : (
        <Badge variant="destructive" className="gap-1 w-fit">
          <Bug className="size-3" />
          Bug
        </Badge>
      )}
    </CardContent>
  );
}

// Static (non-draggable) visual clone used inside a DndContext's
// <DragOverlay> while an unscheduled item is being dragged.
export function UnscheduledItemPreview({ item }: { item: UnscheduledItem }) {
  return (
    <div className="w-56 rotate-1 scale-105">
      <Card size="sm" className="w-full bg-white shadow-xl ring-2 ring-indigo-200">
        <CardHeader className="flex-row items-start gap-2 pr-2">
          <GripVertical className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
          <CardTitle className="flex-1 text-sm leading-snug">{item.title}</CardTitle>
        </CardHeader>
        <UnscheduledItemBody item={item} />
      </Card>
    </div>
  );
}
