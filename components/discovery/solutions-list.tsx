"use client";

import { useEffect, useState, useTransition, useId } from "react";
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
  /** True when the workspace has an active Solution scoring model. */
  showScore?: boolean;
  onChanged?: () => void;
};

export function SolutionsList({
  solutions: initialSolutions,
  revalidatePathStr,
  showScore = false,
  onChanged,
}: Props) {
  const [solutions, setSolutions] = useState(initialSolutions);
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setSolutions(initialSolutions); }, [initialSolutions]);

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

    const oldIndex = solutions.findIndex((s) => s.id === activeId);
    const newIndex = solutions.findIndex((s) => s.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove(solutions, oldIndex, newIndex).map((sol, idx) => ({
        ...sol,
        sortOrder: idx,
      }));
      setSolutions(reordered);

      startTransition(async () => {
        setError(null);
        try {
          await reorderSolution(activeId, newIndex, revalidatePathStr);
          onChanged?.();
        } catch {
          setSolutions(initialSolutions);
          setError("Could not reorder solutions. Please try again.");
        }
      });
    }
  }

  const solutionIds = solutions.map((s) => s.id);

  return (
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={solutionIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-3">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {solutions.map((solution) => (
            <SolutionCard
              key={solution.id}
              solution={solution}
              revalidatePathStr={revalidatePathStr}
              showScore={showScore}
              scoringHref={revalidatePathStr}
              onChanged={onChanged}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
