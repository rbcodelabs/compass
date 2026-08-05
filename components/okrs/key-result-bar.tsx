"use client";

import * as React from "react";
import { useTransition } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { CheckInForm } from "@/components/okrs/check-in-form";
import { CardMenu } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import { deleteKeyResult } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import { averageProgress, clampProgress } from "@/lib/okrs";
import type { ObjectiveStatus, SquadData } from "@/lib/types";

interface KeyResultBarProps {
  keyResult: {
    id: string;
    title: string;
    current: number;
    target: number;
    unit: string | null;
    supportingObjectives?: Array<{
      id: string;
      title: string;
      status: ObjectiveStatus;
      cycle: { id: string; title: string };
      squad: SquadData | null;
      keyResults: Array<{ current: number; target: number }>;
    }>;
  };
  orgSlug: string;
  workspaceSlug: string;
}

export function KeyResultBar({ keyResult, orgSlug, workspaceSlug }: KeyResultBarProps) {
  const [, startTransition] = useTransition();
  const { openPanel } = usePanelContext();
  const progress = clampProgress(keyResult.current, keyResult.target);
  const unit = keyResult.unit ? ` ${keyResult.unit}` : "";
  const okrsPath = `/${orgSlug}/${workspaceSlug}/okrs`;

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: keyResult.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function handleDelete() {
    startTransition(async () => {
      await deleteKeyResult(keyResult.id, okrsPath);
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="flex flex-col gap-1.5 group touch-none">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          {/* Drag handle */}
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none text-muted-foreground/40 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none rounded"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => openPanel("keyResult", keyResult.id)}
            className="min-w-0 overflow-hidden text-left"
          >
            <span className="text-sm text-foreground truncate hover:underline underline-offset-2">
              {keyResult.title}
            </span>
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-end sm:self-auto">
          <span className="text-xs text-muted-foreground">
            {keyResult.current}{unit} / {keyResult.target}{unit}
          </span>
          <CheckInForm
            keyResultId={keyResult.id}
            keyResultTitle={keyResult.title}
            currentValue={keyResult.current}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
          <CardMenu
            items={[
              {
                label: "Delete KR",
                onClick: () => handleDelete(),
                destructive: true,
              },
            ]}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground w-8 text-right">
          {progress}%
        </span>
      </div>

      {keyResult.supportingObjectives && keyResult.supportingObjectives.length > 0 && (
        <div className="ml-5 mt-1 flex flex-col gap-1 rounded-md bg-muted/50 px-2.5 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Supporting objectives
          </p>
          {keyResult.supportingObjectives.map((objective) => (
            <button
              key={objective.id}
              type="button"
              onClick={() => openPanel("objective", objective.id)}
              className="flex items-start justify-between gap-3 rounded-sm py-0.5 text-left hover:underline underline-offset-2 sm:items-center"
            >
              <span className="min-w-0 text-xs">
                <span className="block truncate">{objective.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground sm:ml-1.5 sm:inline">
                  {objective.cycle.title}{objective.squad ? ` · ${objective.squad.name}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {averageProgress(objective.keyResults)}%
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
