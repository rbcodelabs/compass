"use client";

import { useState, useTransition } from "react";
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
import {
  reorderObjective,
  reorderKeyResult,
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
};

export function ObjectivesList({
  objectives: initialObjectives,
  orgSlug,
  workspaceSlug,
  cyclePath,
  availableKRs = [],
  supportingObjectiveOptions,
}: Props) {
  const [objectives, setObjectives] = useState(initialObjectives);
  const [, startTransition] = useTransition();

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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={objectiveIds} strategy={verticalListSortingStrategy}>
        {objectives.map((obj) => (
          <ObjectiveRowWithKRSort
            key={obj.id}
            objective={obj}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
            revalidatePathStr={cyclePath}
            availableKRs={availableKRs}
            parentKeyResultId={obj.parentKeyResultId ?? null}
            supportingObjectiveOptions={supportingObjectiveOptions}
          />
        ))}
      </SortableContext>
    </DndContext>
  );
}

// ─── ObjectiveRow with inner KR sort context ──────────────────────────────────

function ObjectiveRowWithKRSort({
  objective,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  availableKRs,
  parentKeyResultId,
  supportingObjectiveOptions,
}: {
  objective: ObjectiveData;
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  availableKRs?: ParentKROption[];
  parentKeyResultId?: string | null;
  supportingObjectiveOptions?: SupportingObjectiveOption[];
}) {
  const [keyResults, setKeyResults] = useState(objective.keyResults);
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleKRDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const oldIndex = keyResults.findIndex((kr) => kr.id === activeId);
    const newIndex = keyResults.findIndex((kr) => kr.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove(keyResults, oldIndex, newIndex);
      setKeyResults(reordered);

      startTransition(async () => {
        await reorderKeyResult(activeId, newIndex, revalidatePathStr);
      });
    }
  }

  const krIds = keyResults.map((kr) => kr.id);

  // Merge sorted KRs back into the objective for ObjectiveRow
  const objectiveWithSortedKRs = { ...objective, keyResults };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleKRDragEnd}
    >
      <SortableContext items={krIds} strategy={verticalListSortingStrategy}>
        <ObjectiveRow
          objective={objectiveWithSortedKRs}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          revalidatePathStr={revalidatePathStr}
          availableKRs={availableKRs}
          parentKeyResultId={parentKeyResultId}
          supportingObjectiveOptions={supportingObjectiveOptions}
        />
      </SortableContext>
    </DndContext>
  );
}
