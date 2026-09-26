"use client";

import * as React from "react";
import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AssumptionItem, type AssumptionItemData } from "@/components/discovery/assumption-item";
import { addAssumption, reorderAssumption } from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import type { RiskLevel } from "@/lib/types";

/**
 * The Solution panel's full-featured Assumptions section — the sidebar
 * equivalent of the block that used to live inside the expanding
 * discovery/solution-card.tsx. Same drag-to-reorder + add-assumption
 * behavior, reusing the shared AssumptionItem row.
 */
type Props = {
  solutionId: string;
  workspaceId: string;
  assumptions: AssumptionItemData[];
  revalidatePathStr: string;
  /** Refetch the parent panel's data — called after any mutation that isn't
   * reflected by this component's own optimistic local state (add; reorder
   * and status-advance/delete are handled optimistically/by AssumptionItem). */
  onChanged: () => void;
};

export function SolutionAssumptions({
  solutionId,
  workspaceId,
  assumptions: initialAssumptions,
  revalidatePathStr,
  onChanged,
}: Props) {
  // Add/delete/status-advance all call onChanged (the panel's refresh), which
  // remounts this component via the `key` the panel passes (see
  // solution-panel.tsx) — so a plain useState seeded from props is enough;
  // no effect needed to keep this in sync with a prop that changes in place.
  const [assumptions, setAssumptions] = useState(initialAssumptions);

  const [addingAssumption, setAddingAssumption] = useState(false);
  const [assumptionRisk, setAssumptionRisk] = useState<RiskLevel>("MEDIUM");
  const [isPending, startTransition] = useTransition();
  const [, startReorderTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = React.useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const oldIndex = assumptions.findIndex((a) => a.id === activeId);
    const newIndex = assumptions.findIndex((a) => a.id === overId);

    if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
      const reordered = arrayMove(assumptions, oldIndex, newIndex);
      setAssumptions(reordered);

      startReorderTransition(async () => {
        await reorderAssumption(activeId, newIndex, revalidatePathStr);
      });
    }
  }

  function handleAdd(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("assumptionTitle") as string).trim();
    if (!title) return;

    startTransition(async () => {
      await addAssumption(solutionId, { title, riskLevel: assumptionRisk }, revalidatePathStr);
      form.reset();
      setAssumptionRisk("MEDIUM");
      setAddingAssumption(false);
      onChanged();
    });
  }

  const assumptionIds = assumptions.map((a) => a.id);

  return (
    <div className="flex flex-col gap-1">
      {assumptions.length === 0 && !addingAssumption && (
        <p className="text-sm text-muted-foreground">No assumptions yet.</p>
      )}

      <DndContext id={dndId} sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={assumptionIds} strategy={verticalListSortingStrategy}>
          {assumptions.map((a) => (
            <AssumptionItem
              key={a.id}
              assumption={a}
              revalidatePathStr={revalidatePathStr}
              workspaceId={workspaceId}
              onChanged={onChanged}
            />
          ))}
        </SortableContext>
      </DndContext>

      {addingAssumption ? (
        <form onSubmit={handleAdd} className="flex flex-col gap-2 mt-2">
          <Input
            ref={inputRef}
            name="assumptionTitle"
            placeholder="Assumption title"
            autoFocus
            required
            disabled={isPending}
            className="h-8 text-sm"
          />
          <div className="flex items-center gap-2">
            <Select
              value={assumptionRisk}
              onValueChange={(v: string | null) => {
                if (v) setAssumptionRisk(v as RiskLevel);
              }}
              disabled={isPending}
            >
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="HIGH">High risk</SelectItem>
                <SelectItem value="MEDIUM">Medium risk</SelectItem>
                <SelectItem value="LOW">Low risk</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Adding..." : "Add"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={() => setAddingAssumption(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 text-muted-foreground w-fit"
          onClick={() => setAddingAssumption(true)}
        >
          <PlusIcon />
          Add Assumption
        </Button>
      )}
    </div>
  );
}
