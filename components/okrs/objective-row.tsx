"use client";

import * as React from "react";
import { useId, useRef, useTransition, useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, GripVertical, X } from "lucide-react";
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
} from "@/components/ui/combobox";
import {
  updateObjectiveStatus,
  setObjectiveParentKR,
  deleteObjective,
  reorderKeyResult,
} from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import { CardMenu, type CardMenuItem } from "@/components/ui/card-menu";
import { usePanelContext } from "@/components/panels/panel-context";
import { EntityCard } from "@/components/patterns/entity-card";
import { MiniRing } from "@/components/okrs/okr-visuals";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";

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
  /** Owning Objective; lets a cycle-less Objective exclude its own KRs. */
  objectiveId?: string;
  cycleId: string | null;
  /** NO_CYCLE_LABEL for a cycle-less parent Objective. */
  cycleTitle: string;
  cycleStatus: string | null;
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
  /** Percent of the cycle elapsed, threaded to each key result's pace tick. */
  paceElapsed?: number | null;
  /** Hide progress visuals (ring, bars, percentages) for a not-yet-started period. */
  hideProgress?: boolean;
  /** Controlled collapsed state. Omit for an uncontrolled row that starts expanded. */
  collapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function ObjectiveRow({
  objective,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  availableKRs,
  parentKeyResultId,
  supportingObjectiveOptions,
  paceElapsed,
  hideProgress,
  collapsed: collapsedProp,
  onCollapsedChange,
}: ObjectiveRowProps) {
  const labels = useLabels();
  const [localCollapsed, setLocalCollapsed] = useState(false);
  const collapsed = collapsedProp ?? localCollapsed;
  const bodyId = useId();
  function toggleCollapsed() {
    const next = !collapsed;
    if (collapsedProp === undefined) setLocalCollapsed(next);
    onCollapsedChange?.(next);
  }
  const krCount = objective.keyResults.length;
  const krCountLabel = `${krCount} ${krCount === 1 ? labels.keyResult.lower : labels.keyResult.lowerPlural}`;
  const [isPending, startTransition] = useTransition();
  const [isParentKRPending, startParentKRTransition] = useTransition();
  const [parentKRError, setParentKRError] = useState<string | null>(null);
  const [isParentLinkOpen, setIsParentLinkOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
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

  // A cycle-less Objective has no date window excluding its own KRs, so the
  // picker drops them here (linking to one would be rejected as SAME_OBJECTIVE).
  const selectableKRs = availableKRs?.filter((kr) => kr.objectiveId !== objective.id);
  const canLinkParent = !!selectableKRs && !localParentKRId && selectableKRs.length > 0;
  const menuItems: CardMenuItem[] = [
    ...(canLinkParent
      ? [
          {
            label: `Link to parent ${labels.keyResult.singular}…`,
            // Defer until the dropdown has closed so focus moves cleanly into the combobox popup.
            onClick: () => requestAnimationFrame(() => setIsParentLinkOpen(true)),
          },
        ]
      : []),
    {
      label: `Delete ${labels.objective.singular}`,
      onClick: () => handleDelete(),
      destructive: true,
      separator: canLinkParent,
    },
  ];

  return (
    <EntityCard
      ref={setNodeRef}
      style={style}
      interactive
      className="touch-none okx-obj"
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
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-expanded={!collapsed}
                aria-controls={bodyId}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${objective.title}`}
                className="shrink-0 rounded text-text-subtle hover:text-text-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
              >
                {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
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
      description={
        [objective.owner, objective.squad?.name, collapsed ? krCountLabel : null].filter(Boolean).join(" · ") || undefined
      }
      bodyClassName={collapsed ? "mt-0" : undefined}
      actions={
        <div ref={actionsRef} className="flex shrink-0 items-center gap-2">
          {/* Overall progress */}
          {objective.keyResults.length > 0 && !hideProgress && (
            <MiniRing progress={avgProgress} />
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
          <CardMenu items={menuItems} />
        </div>
      }
    >
      {/* Parent-KR link picker — opened from the ⋯ menu, renders nothing until opened */}
      {canLinkParent && (
        <Combobox
          items={selectableKRs!.map((kr) => ({
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
          open={isParentLinkOpen}
          onOpenChange={setIsParentLinkOpen}
        >
          <ComboboxContent
            anchor={actionsRef}
            align="end"
            inputPlaceholder={`Search ${labels.cycle.lowerPlural}, ${labels.objective.lowerPlural}, and ${labels.keyResult.shortPlural}…`}
            emptyMessage={`No eligible parent ${labels.keyResult.shortPlural}. A ${labels.cycle.lower}-less ${labels.objective.singular} can support any ${labels.keyResult.singular} in a Draft or Active ${labels.cycle.lower}; otherwise the parent ${labels.cycle.lower} must be Draft or Active, longer, and fully contain this ${labels.cycle.lower}'s dates.`}
          />
        </Combobox>
      )}

      {/* Everything that hides on collapse stays mounted so KR reorder state and open forms survive a toggle. */}
      <div id={bodyId} hidden={collapsed}>
      {/* Key results */}
      {objective.keyResults.length > 0 && (
        <SortableKeyResults
          keyResults={objective.keyResults}
          objectiveId={objective.id}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={revalidatePathStr ?? okrsPath}
          supportingObjectiveOptions={supportingObjectiveOptions}
          paceElapsed={paceElapsed}
          hideProgress={hideProgress}
        />
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

      {/* Objective alignment — parent KR shown as a compact chip at rest */}
      {availableKRs && (localParentKRId || parentKRError) && (
        <div className="flex items-center gap-1.5">
          {localParentKRId &&
            (() => {
              const parentKR = availableKRs.find((kr) => kr.id === localParentKRId);
              const parentLabel = parentKR
                ? `${parentKR.title} · ${parentKR.cycleTitle}`
                : `Linked ${labels.keyResult.singular}`;
              return (
                <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                    Supports
                  </span>
                  <span className="min-w-0 truncate">{parentLabel}</span>
                  <button
                    type="button"
                    onClick={() => handleParentKRChange(null)}
                    disabled={isParentKRPending}
                    className="shrink-0 rounded p-0.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    aria-label={`Unlink parent ${labels.keyResult.singular}`}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })()}
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
      </div>
    </EntityCard>
  );
}

/**
 * The key-result list owns its own DndContext, scoped to just the list. It must
 * not wrap the whole ObjectiveRow: the row's useSortable (objective reorder)
 * resolves the nearest SortableContext, so an enclosing key-result context
 * would swallow the objective drag and reorder would silently do nothing.
 */
function SortableKeyResults({
  keyResults: initialKeyResults,
  objectiveId,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  supportingObjectiveOptions,
  paceElapsed,
  hideProgress,
}: {
  keyResults: KeyResult[];
  objectiveId: string;
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  supportingObjectiveOptions?: SupportingObjectiveOption[];
  paceElapsed?: number | null;
  hideProgress?: boolean;
}) {
  const [keyResults, setKeyResults] = useState(initialKeyResults);
  const [, startTransition] = useTransition();

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const oldIndex = keyResults.findIndex((kr) => kr.id === activeId);
    const newIndex = keyResults.findIndex((kr) => kr.id === (over.id as string));

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      setKeyResults(arrayMove(keyResults, oldIndex, newIndex));
      startTransition(async () => {
        await reorderKeyResult(activeId, newIndex, revalidatePathStr);
      });
    }
  }

  return (
    <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={keyResults.map((kr) => kr.id)} strategy={verticalListSortingStrategy}>
        <div className="okx-krs">
          {keyResults.map((kr) => (
            <KeyResultBar
              key={kr.id}
              keyResult={kr}
              objectiveId={objectiveId}
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              supportingObjectiveOptions={supportingObjectiveOptions}
              paceElapsed={paceElapsed}
              hideProgress={hideProgress}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
