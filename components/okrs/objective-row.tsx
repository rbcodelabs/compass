"use client";

import * as React from "react";
import { useTransition, useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Link2, X } from "lucide-react";
import type { ObjectiveStatus, CustomFieldDefinitionData, CustomFieldValue, SquadData } from "@/lib/types";
import { averageProgress, STATUS_BADGE } from "@/lib/okrs";
import { KeyResultBar } from "@/components/okrs/key-result-bar";
import type { SupportingObjectiveOption } from "@/components/okrs/key-result-bar";
import { AddKeyResultForm } from "@/components/okrs/add-key-result-form";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ProgressRing } from "@/components/ui/progress-ring";
import {
  updateObjectiveStatus,
  setObjectiveParentKR,
  deleteObjective,
} from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import { CardMenu } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import { EntityCard } from "@/components/patterns/entity-card";

interface KeyResult {
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
}

export interface ParentKROption {
  id: string;
  title: string;
  objectiveTitle: string;
  cycleId: string;
  cycleTitle: string;
  cycleStatus: string;
}

interface ObjectiveRowProps {
  objective: {
    id: string;
    title: string;
    status: ObjectiveStatus;
    owner: string | null;
    keyResults: KeyResult[];
    customFields?: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }>;
    squad?: SquadData | null;
  };
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr?: string;
  availableKRs?: ParentKROption[];
  parentKeyResultId?: string | null;
  supportingObjectiveOptions?: SupportingObjectiveOption[];
}

export function ObjectiveRow({
  objective,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  availableKRs,
  parentKeyResultId,
  supportingObjectiveOptions,
}: ObjectiveRowProps) {
  const [isPending, startTransition] = useTransition();
  const [isParentKRPending, startParentKRTransition] = useTransition();
  const [parentKRError, setParentKRError] = useState<string | null>(null);
  const { openPanel } = usePanelContext();
  const [localParentKRId, setLocalParentKRId] = useState<string | null>(
    parentKeyResultId ?? null
  );
  const avgProgress = averageProgress(objective.keyResults);
  const badge = STATUS_BADGE[objective.status];

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: objective.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function handleStatusChange(value: string | null) {
    if (!value) return;
    startTransition(async () => {
      await updateObjectiveStatus(
        objective.id,
        value as ObjectiveStatus,
        orgSlug,
        workspaceSlug
      );
    });
  }

  function handleParentKRChange(value: string | null) {
    const newId = !value || value === "__none__" ? null : value;
    const previousId = localParentKRId;
    setParentKRError(null);
    setLocalParentKRId(newId);
    startParentKRTransition(async () => {
      try {
        await setObjectiveParentKR(objective.id, newId, orgSlug, workspaceSlug);
      } catch (error) {
        setLocalParentKRId(previousId);
        setParentKRError(error instanceof Error ? error.message : "Could not update hierarchy.");
      }
    });
  }

  const okrsPath = `/${orgSlug}/${workspaceSlug}/okrs`;

  function handleDelete() {
    startTransition(async () => {
      await deleteObjective(objective.id, okrsPath);
    });
  }

  return (
    <EntityCard
      ref={setNodeRef}
      style={style}
      interactive
      className="touch-none"
      data-pending={isPending || isParentKRPending ? true : undefined}
      leading={
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-4" />
          </button>
      }
      title={
        <span className="flex items-center gap-2">
              {objective.squad && (
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: objective.squad.color }}
                  title={objective.squad.name}
                />
              )}
              <button
                type="button"
                onClick={() => openPanel("objective", objective.id)}
                className="text-left font-medium text-base hover:underline underline-offset-2"
              >
                {objective.title}
              </button>
        </span>
      }
      description={[objective.owner, objective.squad?.name].filter(Boolean).join(" · ") || undefined}
      actions={
        <div className="flex shrink-0 items-center gap-2">
          {/* Overall progress */}
          {objective.keyResults.length > 0 && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <ProgressRing value={avgProgress} size={22} className="text-primary/60" />
              {avgProgress}%
            </span>
          )}

          {/* Status select */}
          <Select
            value={objective.status}
            onValueChange={handleStatusChange}
            disabled={isPending}
          >
            <SelectTrigger size="sm" className={badge.className}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.keys(STATUS_BADGE) as ObjectiveStatus[]
              ).map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_BADGE[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <CardMenu
            items={[
              {
                label: "Delete Objective",
                onClick: () => handleDelete(),
                separator: true,
                destructive: true,
              },
            ]}
          />
        </div>
      }
    >

      {/* Key results */}
      {objective.keyResults.length > 0 && (
        <div className="flex flex-col gap-3 pl-2 border-l border-border">
          {objective.keyResults.map((kr) => (
            <KeyResultBar
              key={kr.id}
              keyResult={kr}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              supportingObjectiveOptions={supportingObjectiveOptions}
            />
          ))}
        </div>
      )}

      {/* Custom fields */}
      {objective.customFields && objective.customFields.length > 0 && revalidatePathStr && (
        <div className="pt-1">
          <CustomFieldsPanel
            fields={objective.customFields}
            objectId={objective.id}
            revalidatePathStr={revalidatePathStr}
          />
        </div>
      )}

      {/* Objective alignment */}
      {availableKRs && (
        <div className="flex items-center gap-1.5">
          {localParentKRId ? (
            (() => {
              const parentKR = availableKRs.find((kr) => kr.id === localParentKRId);
              const parentLabel = parentKR
                ? `${parentKR.title} · ${parentKR.cycleTitle}`
                : "Linked Key Result";
              return (
                <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="min-w-0 truncate">{parentLabel}</span>
                  <button
                    type="button"
                    onClick={() => handleParentKRChange(null)}
                    disabled={isParentKRPending}
                    className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    aria-label="Unlink parent Key Result"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })()
          ) : (
            <Combobox
              items={availableKRs.map((kr) => ({
                value: kr.id,
                label: `${kr.cycleTitle} ${kr.objectiveTitle} ${kr.title}`,
                render: (
                  <span className="flex min-w-0 flex-col text-left">
                    <span className="truncate text-xs font-medium">{kr.title}</span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {kr.cycleTitle} · {kr.objectiveTitle}
                      {kr.cycleStatus === "CLOSED" ? " · Closed" : ""}
                    </span>
                  </span>
                ),
              }))}
              value={null}
              onValueChange={handleParentKRChange}
              disabled={isParentKRPending}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <ComboboxTrigger
                      variant="icon"
                      aria-label="Supports a higher-level Key Result"
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100"
                    >
                      <Link2 className="size-3.5" />
                    </ComboboxTrigger>
                  }
                />
                <TooltipContent>Supports a higher-level Key Result</TooltipContent>
              </Tooltip>
              <ComboboxContent
                inputPlaceholder="Search cycles, objectives, and KRs…"
                emptyMessage="No eligible parent KRs. A longer cycle must be Draft or Active and fully contain this cycle's dates."
              />
            </Combobox>
          )}
          {parentKRError && <p className="text-xs text-destructive">{parentKRError}</p>}
        </div>
      )}

      {/* Add key result */}
      <div>
        <AddKeyResultForm
          objectiveId={objective.id}
          objectiveTitle={objective.title}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </EntityCard>
  );
}
