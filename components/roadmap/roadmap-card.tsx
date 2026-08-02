"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lightbulb, FlaskConical, Layers, TrendingUp, Bug, CalendarDays, Lock, Rocket } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardMenu } from "@/components/ui/card-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { archiveItem } from "@/app/[orgSlug]/[workspaceSlug]/roadmap/actions";
import { usePanelContext } from "@/components/panels/panel-context";
import { EditItemDialog } from "./edit-item-dialog";

import type { Horizon } from "@/lib/types";
import { isLaunchHorizon } from "@/lib/roadmap";

export type RoadmapCardData = {
  id: string;
  title: string;
  description: string | null;
  horizon: Horizon;
  sortOrder: number;
  isPrivate: boolean;
  solutionId: string | null;
  keyResultId: string | null;
  opportunityId: string | null;
  experimentId: string | null;
  feedbackId: string | null;
  startDate: string | null;
  endDate: string | null;
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
  feedback: { id: string; title: string; type: string } | null;
  squad: { id: string; name: string; color: string } | null;
  launchChecklist: { tier: string; done: number; total: number } | null;
};

// Compact "Mar 3 – Apr 10" style range formatter. Handles single-ended ranges too.
//
// timeZone: "UTC" is required here — start/end dates come from a plain
// <input type="date"> (e.g. "2026-07-01"), which `new Date(...)` parses as
// UTC midnight. Formatting in the viewer's local timezone would shift the
// displayed date back a day for any negative UTC offset (e.g. US timezones),
// so we format in UTC to match how the date was parsed.
function formatDateRange(startIso: string | null, endIso: string | null): string {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const start = startIso ? fmt.format(new Date(startIso)) : null;
  const end = endIso ? fmt.format(new Date(endIso)) : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `From ${start}`;
  return `Until ${end}`;
}

type Props = {
  item: RoadmapCardData;
  revalidatePathStr: string;
  onArchive: (itemId: string) => void;
  onUpdate?: (item: RoadmapCardData) => void;
  orgSlug: string;
  workspaceSlug: string;
};

export function RoadmapCard({ item, revalidatePathStr, onArchive, onUpdate, orgSlug, workspaceSlug }: Props) {
  const [isArchiving, startArchiveTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);
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
  const hasDates = Boolean(item.startDate || item.endDate);

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
          <CardTitle className="flex-1 text-sm leading-snug flex items-center gap-1.5 flex-wrap">
            {item.feedback?.type === "BUG" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-50 text-red-600 px-1.5 py-0.5 text-[10px] font-medium shrink-0">
                <Bug className="size-2.5" />
                Bug
              </span>
            )}
            {item.isPrivate && (
              <span
                title="Hidden from the public portal roadmap"
                className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 px-1.5 py-0.5 text-[10px] font-medium shrink-0"
              >
                <Lock className="size-2.5" />
                Private
              </span>
            )}
            {isLaunchHorizon(item.horizon) && item.launchChecklist && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openPanel("roadmapItem", item.id);
                }}
                title={`Launch checklist: ${item.launchChecklist.done} of ${item.launchChecklist.total} done`}
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors px-1.5 py-0.5 text-[10px] font-medium shrink-0"
              >
                <Rocket className="size-2.5" />
                {item.launchChecklist.done}/{item.launchChecklist.total}
              </button>
            )}
            <button
              type="button"
              onClick={() => openPanel("roadmapItem", item.id)}
              className="text-left hover:underline underline-offset-2"
            >
              {item.title}
            </button>
          </CardTitle>

          <CardMenu
            items={[
              {
                label: "Edit",
                onClick: () => setEditOpen(true),
              },
              {
                label: "Launch",
                onClick: () => openPanel("roadmapItem", item.id),
              },
              {
                label: "Archive",
                onClick: () => handleArchive(),
                destructive: true,
              },
            ]}
          />
        </CardHeader>

        {(item.description || hasLinks || hasDates) && (
          <CardContent className="flex flex-col gap-2 pt-0">
            {item.description && (
              <p className="text-xs text-muted-foreground line-clamp-2">
                {item.description}
              </p>
            )}

            {(hasLinks || hasDates) && (
              <TooltipProvider delay={400}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 pt-2 mt-0.5">
                  {/* Dates */}
                  {hasDates && (
                    <span className="flex items-center gap-1 text-[11px] text-muted-foreground/60 min-w-0">
                      <CalendarDays className="size-3 shrink-0" />
                      <span className="truncate">{formatDateRange(item.startDate, item.endDate)}</span>
                    </span>
                  )}

                  {/* Opportunity */}
                  {item.opportunity && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPanel("opportunity", item.opportunity!.id);
                            }}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-violet-600 transition-colors min-w-0"
                          />
                        }
                      >
                        <Lightbulb className="size-3 shrink-0" />
                        <span className="truncate max-w-[120px]">{item.opportunity.title}</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{item.opportunity.title}</TooltipContent>
                    </Tooltip>
                  )}

                  {/* Solution */}
                  {item.solution && item.opportunityId && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPanel("opportunity", item.opportunityId!);
                            }}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-blue-600 transition-colors min-w-0"
                          />
                        }
                      >
                        <Layers className="size-3 shrink-0" />
                        <span className="truncate max-w-[120px]">{item.solution.title}</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{item.solution.title}</TooltipContent>
                    </Tooltip>
                  )}
                  {item.solution && !item.opportunityId && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Link
                            href={`${base}/discovery`}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-blue-600 transition-colors min-w-0"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <Layers className="size-3 shrink-0" />
                        <span className="truncate max-w-[120px]">{item.solution.title}</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{item.solution.title}</TooltipContent>
                    </Tooltip>
                  )}

                  {/* Experiment */}
                  {item.experiment && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPanel("experiment", item.experiment!.id);
                            }}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-amber-600 transition-colors min-w-0"
                          />
                        }
                      >
                        <FlaskConical className="size-3 shrink-0" />
                        <span className="truncate max-w-[120px]">{item.experiment.title}</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{item.experiment.title}</TooltipContent>
                    </Tooltip>
                  )}

                  {/* KR */}
                  {item.keyResult && krProgress !== null && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Link
                            href={item.keyResult.cycleId
                              ? `${base}/okrs/${item.keyResult.cycleId}`
                              : `${base}/okrs`}
                            className="flex items-center gap-1 text-[11px] text-muted-foreground/60 hover:text-indigo-600 transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <TrendingUp className="size-3 shrink-0" />
                        <span className="tabular-nums">{krProgress}%</span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">{item.keyResult.title}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </TooltipProvider>
            )}
          </CardContent>
        )}
      </Card>

      <EditItemDialog
        item={item}
        open={editOpen}
        onOpenChange={setEditOpen}
        revalidatePathStr={revalidatePathStr}
        onSaved={(updated) => onUpdate?.(updated)}
      />
    </div>
  );
}
