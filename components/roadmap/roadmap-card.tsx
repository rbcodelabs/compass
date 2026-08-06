"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Lightbulb, FlaskConical, Layers, TrendingUp, Bug, CalendarDays, Lock, Rocket } from "lucide-react";
import { EntityCard } from "@/components/patterns/entity-card";
import { StatusBadge } from "@/components/patterns/status-badge";
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
      <EntityCard
        interactive
        className="w-full p-3 data-[pending]:opacity-60 data-[dragging=true]:shadow-[var(--shadow-panel)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/30"
        data-dragging={isDragging ? true : undefined}
        data-pending={isArchiving ? true : undefined}
        leading={
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        title={
          <span className="flex flex-wrap items-center gap-1.5">
            {item.feedback?.type === "BUG" && (
              <StatusBadge status="danger" icon={<Bug />}>Bug</StatusBadge>
            )}
            {item.isPrivate && (
              <StatusBadge status="neutral" icon={<Lock />} title="Hidden from the public portal roadmap">Private</StatusBadge>
            )}
            {isLaunchHorizon(item.horizon) && item.launchChecklist && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  openPanel("roadmapItem", item.id);
                }}
                title={`Launch checklist: ${item.launchChecklist.done} of ${item.launchChecklist.total} done`}
                className="inline-flex h-5 items-center gap-1 rounded-full bg-status-warning-surface px-2 text-xs font-medium text-status-warning hover:brightness-95"
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
          </span>
        }
        description={item.description}
        actions={
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
        }
      >
        {(hasLinks || hasDates) && (
              <TooltipProvider delay={400}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-default pt-2">
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
      </EntityCard>

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
