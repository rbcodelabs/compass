"use client";

import * as React from "react";
import { useTransition } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { archiveItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import type { Horizon } from "@/lib/types";

export type RoadmapCardData = {
  id: string;
  title: string;
  description: string | null;
  horizon: Horizon;
  sortOrder: number;
  solutionId: string | null;
  keyResultId: string | null;
  solution: { id: string; title: string } | null;
  keyResult: { id: string; title: string; current: number; target: number; unit: string | null } | null;
};

type Props = {
  item: RoadmapCardData;
  revalidatePathStr: string;
  onArchive: (itemId: string) => void;
};

export function RoadmapCard({ item, revalidatePathStr, onArchive }: Props) {
  const [isArchiving, startArchiveTransition] = useTransition();

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, data: { horizon: item.horizon } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const krProgress =
    item.keyResult && item.keyResult.target > 0
      ? Math.round((item.keyResult.current / item.keyResult.target) * 100)
      : null;

  function handleArchive() {
    // Optimistic update: remove from UI immediately
    onArchive(item.id);
    startArchiveTransition(async () => {
      await archiveItem(item.id, revalidatePathStr);
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="touch-none">
      <Card
        size="sm"
        className="w-full bg-white shadow-sm transition-all duration-150 data-[dragging=true]:shadow-xl data-[dragging=true]:ring-2 data-[dragging=true]:ring-indigo-200"
        data-dragging={isDragging ? true : undefined}
      >
        <CardHeader className="flex-row items-start gap-2 pr-2">
          {/* Drag handle */}
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>

          {/* Title */}
          <CardTitle className="flex-1 text-sm leading-snug">
            {item.title}
          </CardTitle>

          {/* Archive button */}
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-muted-foreground/50 hover:text-destructive"
            onClick={handleArchive}
            disabled={isArchiving}
            aria-label="Archive item"
          >
            <X className="size-3" />
          </Button>
        </CardHeader>

        {(item.description || item.solution || item.keyResult) && (
          <CardContent className="flex flex-col gap-2 pt-0">
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}

            {(item.solution || item.keyResult) && (
              <div className="flex flex-wrap gap-1">
                {item.solution && (
                  <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {item.solution.title}
                  </Badge>
                )}
                {krProgress !== null && (
                  <Badge variant="outline" className="text-xs">
                    KR: {krProgress}%
                  </Badge>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
