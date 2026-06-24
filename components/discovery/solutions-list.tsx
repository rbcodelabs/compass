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
import { SolutionCard, type SolutionCardData } from "./solution-card";
import { reorderSolution } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";

type Props = {
  solutions: SolutionCardData[];
  revalidatePathStr: string;
  workspaceId: string;
  opportunityId: string;
  squadId: string | null;
};

export function SolutionsList({
  solutions: initialSolutions,
  revalidatePathStr,
  workspaceId,
  opportunityId,
  squadId,
}: Props) {
  const [solutions, setSolutions] = useState(initialSolutions);
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

    const oldIndex = solutions.findIndex((s) => s.id === activeId);
    const newIndex = solutions.findIndex((s) => s.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove(solutions, oldIndex, newIndex).map((sol, idx) => ({
        ...sol,
        sortOrder: idx,
      }));
      setSolutions(reordered);

      startTransition(async () => {
        await reorderSolution(activeId, newIndex, revalidatePathStr);
      });
    }
  }

  const solutionIds = solutions.map((s) => s.id);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={solutionIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-3">
          {solutions.map((solution) => (
            <SolutionCard
              key={solution.id}
              solution={solution}
              revalidatePathStr={revalidatePathStr}
              workspaceId={workspaceId}
              opportunityId={opportunityId}
              squadId={squadId}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
