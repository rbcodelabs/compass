"use client";

import * as React from "react";
import { useTransition } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardMenu } from "@/components/ui/card-menu";
import { archiveItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { usePanelContext } from "@/components/panels/panel-context";

import type { Horizon } from "@/lib/types";

export type RoadmapCardData = {
  id: string;
  title: string;
  description: string | null;
  horizon: Horizon;
  sortOrder: number;
  solutionId: string | null;
  keyResultId: string | null;
  opportunityId: string | null;
  experimentId: string | null;
  solution: { id: string; title: string } | null;
  keyResult: {
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
    cycleId: string | null;
  } | null;
  opportunity: { id: string; title: string } | null;
  experiment: { id: string; title: string } | null;
};

type Props = {
  item: RoadmapCardData;
  revalidatePathStr: string;
  onArchive: (itemId: string) => void;
  orgSlug: string;
  workspaceSlug: string;
};

export function RoadmapCard({ item, revalidatePathStr, onArchive, orgSlug, workspaceSlug }: Props) {
  const [isArchiving, startArchiveTransition] = useTransition();
  const { openPanel } = usePanelContext();

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
    onArchive(item.id);
    startArchiveTransition(async () => {
      await archiveItem(item.id, revalidatePathStr);
    });
  }

  const base = `/${orgSlug}/${workspaceSlug}`;

  const hasLinks = item.solution || item.keyResult || item.opportunity || item.experiment;

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
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

          <CardMenu
            items={[
              {
                label: "Archive",
                onClick: () => handleArchive(),
                destructive: true,
              },
            ]}
          />
        </CardHeader>

        {(item.description || hasLinks) && (
          <CardContent className="flex flex-col gap-2 pt-0">
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}

            {hasLinks && (
              <div className="flex flex-wrap gap-1">
                {/* Opportunity → slide-over panel */}
                {item.opportunity && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openPanel("opportunity", item.opportunity!.id);
                    }}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-violet-100 text-violet-700 hover:bg-violet-200 transition-colors cursor-pointer"
                  >
                    ↑ {item.opportunity.title}
                  </button>
                )}

                {/* Solution → opportunity panel (solutions live on opp page) */}
                {item.solution && item.opportunityId && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openPanel("opportunity", item.opportunityId!);
                    }}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors cursor-pointer"
                  >
                    {item.solution.title}
                  </button>
                )}
                {item.solution && !item.opportunityId && (
                  <Link
                    href={`${base}/discovery`}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.solution.title}
                  </Link>
                )}

                {/* Experiment → slide-over panel */}
                {item.experiment && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openPanel("experiment", item.experiment!.id);
                    }}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors cursor-pointer"
                  >
                    🧪 {item.experiment.title}
                  </button>
                )}

                {/* KR → OKR cycle page (full nav, no panel yet) */}
                {item.keyResult && krProgress !== null && (
                  <Link
                    href={item.keyResult.cycleId
                      ? `${base}/okrs/${item.keyResult.cycleId}`
                      : `${base}/okrs`}
                    className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border border-border bg-white text-muted-foreground hover:bg-slate-50 transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    KR: {krProgress}%
                  </Link>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
