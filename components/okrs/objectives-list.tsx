"use client";

import { useState, useTransition, useId } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Groupable = SELECT custom fields on objectives (the same definitions are
  // attached to every objective, so read them off the first one).
  const groupableFields = (objectives[0]?.customFields ?? []).filter(
    (f) => f.fieldType === "SELECT" && (f.options?.length ?? 0) > 0
  );
  const groupByParam = searchParams.get("groupBy");
  const groupField = groupByParam?.startsWith("field:")
    ? groupableFields.find((f) => f.id === groupByParam.slice(6)) ?? null
    : null;

  function setGroupBy(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set("groupBy", value);
    else params.delete("groupBy");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const valueOf = (o: ObjectiveData) =>
    groupField ? o.customFields?.find((f) => f.id === groupField.id)?.currentValue : null;
  const groups = groupField
    ? [
        ...(groupField.options ?? []).map((opt) => ({
          key: opt.value,
          label: opt.label,
          color: opt.color,
          items: objectives.filter((o) => valueOf(o) === opt.value),
        })),
        {
          key: "__none__",
          label: `No ${groupField.name}`,
          color: undefined as string | undefined,
          items: objectives.filter(
            (o) => !(groupField.options ?? []).some((opt) => opt.value === valueOf(o))
          ),
        },
      ].filter((g) => g.items.length > 0)
    : null;

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

  const renderRow = (obj: ObjectiveData) => (
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
  );

  return (
    <>
    {(groupableFields.length > 0 || objectives.length > 1) && (
      <div className="flex items-center justify-between gap-3">
        {groupableFields.length > 0 ? (
          <div className="flex items-center gap-2">
            <label htmlFor="okr-group-by" className="text-xs text-text-subtle font-medium">
              Group by:
            </label>
            <select
              id="okr-group-by"
              value={groupField ? `field:${groupField.id}` : ""}
              onChange={(e) => setGroupBy(e.target.value)}
              className="rounded-md border border-border-default bg-transparent px-2 py-1 text-xs"
            >
              <option value="">None</option>
              {groupableFields.map((f) => (
                <option key={f.id} value={`field:${f.id}`}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        ) : <span />}
        {objectives.length > 1 && (
          <button
            type="button"
            onClick={() => setCollapsedIds(allCollapsed ? new Set() : new Set(objectiveIds))}
            className="rounded text-xs text-text-subtle hover:text-text-default hover:underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
          >
            {toggleAllLabel}
          </button>
        )}
      </div>
    )}
    <DndContext
      id={dndId}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      {groups ? (
        groups.map((g) => (
          <section key={g.key} className="flex flex-col gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              {g.color && (
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
              )}
              {g.label}
              <span className="text-xs font-normal text-text-subtle">{g.items.length}</span>
            </h3>
            <SortableContext items={g.items.map((o) => o.id)} strategy={verticalListSortingStrategy}>
              {g.items.map(renderRow)}
            </SortableContext>
          </section>
        ))
      ) : (
        <SortableContext items={objectiveIds} strategy={verticalListSortingStrategy}>
          {objectives.map(renderRow)}
        </SortableContext>
      )}
    </DndContext>
    </>
  );
}
