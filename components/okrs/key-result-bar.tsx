"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Link2, X } from "lucide-react";
import { CheckInForm } from "@/components/okrs/check-in-form";
import { CardMenu } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import { deleteKeyResult, setObjectiveParentKR } from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import { Combobox, ComboboxContent, ComboboxTrigger } from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProgressRing } from "@/components/ui/progress-ring";
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
  supportingObjectiveOptions?: SupportingObjectiveOption[];
}

export interface SupportingObjectiveOption {
  id: string;
  title: string;
  cycleId: string;
  cycleTitle: string;
}

export function KeyResultBar({ keyResult, orgSlug, workspaceSlug, supportingObjectiveOptions }: KeyResultBarProps) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [isLinkPending, startLinkTransition] = useTransition();
  const [linkError, setLinkError] = useState<string | null>(null);
  const [localSupportingObjectives, setLocalSupportingObjectives] = useState(
    keyResult.supportingObjectives ?? []
  );
  const [localSupportingOptions, setLocalSupportingOptions] = useState(
    supportingObjectiveOptions ?? []
  );
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

  function setSupportingObjective(objectiveId: string, parentKeyResultId: string | null) {
    setLinkError(null);
    const previousObjectives = localSupportingObjectives;
    const previousOptions = localSupportingOptions;
    if (parentKeyResultId) {
      const option = localSupportingOptions.find((objective) => objective.id === objectiveId);
      if (option) {
        setLocalSupportingObjectives((objectives) => [
          ...objectives,
          {
            id: option.id,
            title: option.title,
            status: "ON_TRACK",
            cycle: { id: option.cycleId, title: option.cycleTitle },
            squad: null,
            keyResults: [],
          },
        ]);
        setLocalSupportingOptions((options) => options.filter((objective) => objective.id !== objectiveId));
      }
    } else {
      const objective = localSupportingObjectives.find((item) => item.id === objectiveId);
      if (objective) {
        setLocalSupportingObjectives((objectives) => objectives.filter((item) => item.id !== objectiveId));
        setLocalSupportingOptions((options) => [
          ...options,
          {
            id: objective.id,
            title: objective.title,
            cycleId: objective.cycle.id,
            cycleTitle: objective.cycle.title,
          },
        ]);
      }
    }
    startLinkTransition(async () => {
      try {
        await setObjectiveParentKR(objectiveId, parentKeyResultId, orgSlug, workspaceSlug);
        router.refresh();
      } catch (error) {
        setLocalSupportingObjectives(previousObjectives);
        setLocalSupportingOptions(previousOptions);
        setLinkError(error instanceof Error ? error.message : "Could not update hierarchy.");
      }
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
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProgressRing value={progress} size={20} className="text-primary" />
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

      {supportingObjectiveOptions && (
        <div className="ml-5 mt-1 flex flex-col items-start gap-1.5">
          <Combobox
            items={localSupportingOptions.map((objective) => ({
              value: objective.id,
              label: `${objective.title} ${objective.cycleTitle}`,
              render: (
                <span className="flex min-w-0 flex-col text-left">
                  <span className="truncate text-xs font-medium">{objective.title}</span>
                  <span className="truncate text-[11px] text-muted-foreground">{objective.cycleTitle}</span>
                </span>
              ),
            }))}
            value={null}
            onValueChange={(objectiveId) => objectiveId && setSupportingObjective(objectiveId, keyResult.id)}
            disabled={isLinkPending || localSupportingOptions.length === 0}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <ComboboxTrigger
                    variant="icon"
                    aria-label="Link supporting objective"
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                  >
                    <Link2 className="size-3.5" />
                  </ComboboxTrigger>
                }
              />
              <TooltipContent>Link supporting objective</TooltipContent>
            </Tooltip>
            <ComboboxContent
              inputPlaceholder="Search shorter-cycle Objectives…"
              emptyMessage="No eligible unlinked Objectives."
            />
          </Combobox>
          {linkError && <p className="text-xs text-destructive">{linkError}</p>}
        </div>
      )}

      {localSupportingObjectives.length > 0 && (
        <div className="ml-5 mt-1 flex flex-col gap-1 rounded-md bg-muted/50 px-2.5 py-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Supporting objectives
          </p>
          {localSupportingObjectives.map((objective) => (
            <div key={objective.id} className="flex items-start justify-between gap-3 rounded-sm py-0.5 sm:items-center">
              <button type="button" onClick={() => openPanel("objective", objective.id)} className="min-w-0 text-left hover:underline underline-offset-2">
              <span className="min-w-0 text-xs">
                <span className="block truncate">{objective.title}</span>
                <span className="block truncate text-[11px] text-muted-foreground sm:ml-1.5 sm:inline">
                  {objective.cycle.title}{objective.squad ? ` · ${objective.squad.name}` : ""}
                </span>
              </span>
              </button>
              <span className="flex shrink-0 items-center gap-1 text-[11px] tabular-nums text-muted-foreground">
                {averageProgress(objective.keyResults)}%
                <button
                  type="button"
                  onClick={() => setSupportingObjective(objective.id, null)}
                  disabled={isLinkPending}
                  className="rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  aria-label={`Unlink ${objective.title}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
