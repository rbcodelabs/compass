"use client";

import { useState, useTransition, useId } from "react";
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
} from "@dnd-kit/sortable";
import { ObjectiveRow } from "@/components/okrs/objective-row";
import { useLabels } from "@/components/thinking-model/thinking-model-provider";
import {
  reorderObjective,
} from "@/app/[orgSlug]/[workspaceSlug]/okrs/actions";
import type {
  ObjectiveStatus,
  CustomFieldDefinitionData,
  CustomFieldValue,
  SquadData,
} from "@/lib/types";
import type { ParentKROption } from "@/components/okrs/objective-row";
import type { SupportingObjectiveOption } from "@/components/okrs/key-result-bar";

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

interface ObjectiveData {
  id: string;
  title: string;
  status: ObjectiveStatus;
  owner: string | null;
  keyResults: KeyResult[];
  customFields?: Array<CustomFieldDefinitionData & { currentValue: CustomFieldValue }>;
  squad?: SquadData | null;
  parentKeyResultId?: string | null;
}

type Props = {
  objectives: ObjectiveData[];
  orgSlug: string;
  workspaceSlug: string;
  cyclePath: string;
  availableKRs?: ParentKROption[];
  supportingObjectiveOptions?: SupportingObjectiveOption[];
  paceElapsed?: number | null;
  /** Hide progress visuals for a not-yet-started period. */
  hideProgress?: boolean;
};

export function ObjectivesList({
  objectives: initialObjectives,
  orgSlug,
  workspaceSlug,
  cyclePath,
  availableKRs = [],
  supportingObjectiveOptions,
  paceElapsed,
  hideProgress,
}: Props) {
  const [objectives, setObjectives] = useState(initialObjectives);
  const labels = useLabels();
  // Collapsed ids are view state only (not persisted); everything starts expanded.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
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
    const overId = over.id as string;

    const oldIndex = objectives.findIndex((o) => o.id === activeId);
    const newIndex = objectives.findIndex((o) => o.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove(objectives, oldIndex, newIndex).map((obj, idx) => ({
        ...obj,
        sortOrder: idx,
      }));
      setObjectives(reordered);

      startTransition(async () => {
        await reorderObjective(activeId, newIndex, cyclePath);
      });
    }
  }

  const objectiveIds = objectives.map((o) => o.id);

  function setCollapsed(id: string, collapsed: boolean) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (collapsed) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const allCollapsed = objectives.length > 0 && objectives.every((o) => collapsedIds.has(o.id));
  const toggleAllLabel = `${allCollapsed ? "Expand" : "Collapse"} all ${labels.objective.lowerPlural}`;

  return (
    <>
    {objectives.length > 1 && (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setCollapsedIds(allCollapsed ? new Set() : new Set(objectiveIds))}
          className="rounded text-xs text-text-subtle hover:text-text-default hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
        >
          {toggleAllLabel}
        </button>
      </div>
    )}
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={objectiveIds} strategy={verticalListSortingStrategy}>
        {objectives.map((obj) => (
          <ObjectiveRow
            key={obj.id}
            objective={obj}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            revalidatePathStr={cyclePath}
            availableKRs={availableKRs}
            parentKeyResultId={obj.parentKeyResultId ?? null}
            supportingObjectiveOptions={supportingObjectiveOptions}
            paceElapsed={paceElapsed}
            hideProgress={hideProgress}
            collapsed={collapsedIds.has(obj.id)}
            onCollapsedChange={(c) => setCollapsed(obj.id, c)}
          />
        ))}
      </SortableContext>
    </DndContext>
    </>
  );
}
