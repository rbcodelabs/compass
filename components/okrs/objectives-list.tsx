"use client";

import { useState, useTransition, useId, useEffect } from "react";
import { useServerSyncedState } from "@/hooks/use-server-synced-state";
import { useSearchParams } from "next/navigation";
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
import { groupableObjectiveFields } from "@/lib/okr-grouping";
import { useOkrFilter } from "@/components/okrs/okr-filter-context";
import { objectiveMatches, normalizeQuery } from "@/lib/okr-name-filter";
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
  const [isSaving, startTransition] = useTransition();
  // Follows the server (live refresh) but defers adopting it while a reorder/save is in flight.
  // A drag in progress also defers adoption: the list must not change under the pointer.
  const [isDragging, setIsDragging] = useState(false);
  const { state: objectives, setState: setObjectives } = useServerSyncedState(initialObjectives, (o) => o, isSaving || isDragging);
  const labels = useLabels();
  const { query, setCounts } = useOkrFilter();
  const filterActive = normalizeQuery(query) !== "";
  // Reorder state stays on the full list; the filter only narrows what is rendered.
  const visibleObjectives = filterActive ? objectives.filter((o) => objectiveMatches(o, query)) : objectives;
  const shownCount = visibleObjectives.length;
  const totalCount = objectives.length;
  const objectiveIds = visibleObjectives.map((o) => o.id);
  const visibleIds = new Set(objectiveIds);
  useEffect(() => {
    setCounts({ shown: shownCount, total: totalCount });
  }, [shownCount, totalCount, setCounts]);
  // Collapsed ids are view state only (not persisted); everything starts expanded.
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const searchParams = useSearchParams();

  // The picker lives in the page header (OkrGroupByToggle); this list only reads
  // the choice from the URL. Same definitions are attached to every objective.
  const groupableFields = groupableObjectiveFields(objectives[0]?.customFields ?? []);
  const groupByParam = searchParams.get("groupBy");
  const groupField = groupByParam?.startsWith("field:")
    ? groupableFields.find((f) => f.id === groupByParam.slice(6)) ?? null
    : null;

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
    setIsDragging(false);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    if (!visibleIds.has(String(active.id)) || !visibleIds.has(String(over.id))) return;

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
        await reorderObjective(activeId, { anchorId: overId, position: oldIndex < newIndex ? "after" : "before" }, cyclePath);
      });
    }
  }

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

  // Keep each row mounted so filtering preserves open forms and their draft inputs.
  const renderRow = (obj: ObjectiveData) => (
    <ObjectiveRow
      key={obj.id}
      objective={obj}
      hidden={!visibleIds.has(obj.id)}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      revalidatePathStr={cyclePath}
      availableKRs={availableKRs}
      parentKeyResultId={obj.parentKeyResultId ?? null}
      supportingObjectiveOptions={supportingObjectiveOptions}
      paceElapsed={paceElapsed}
      hideProgress={hideProgress}
      // While filtering, matches stay expanded so a key-result hit is visible.
      collapsed={filterActive ? false : collapsedIds.has(obj.id)}
      hideCollapseToggle={filterActive}
      onCollapsedChange={(c) => setCollapsed(obj.id, c)}
    />
  );

  return (
    <>
    {filterActive && visibleObjectives.length === 0 && (
      <div className="rounded-lg border border-dashed border-border-default p-8 text-center text-sm text-text-secondary">
        No {labels.objective.lowerPlural} or {labels.keyResult.lowerPlural} match &ldquo;{query.trim()}&rdquo;.
      </div>
    )}
    {objectives.length > 1 && !filterActive && (
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
      onDragStart={() => setIsDragging(true)}
      onDragCancel={() => setIsDragging(false)}
      onDragEnd={handleDragEnd}
    >
      {groups ? (
        groups.map((g) => {
          const visibleGroupIds = g.items.filter((o) => visibleIds.has(o.id)).map((o) => o.id);
          const hidden = visibleGroupIds.length === 0;
          return (
            <section key={g.key} hidden={hidden} className={hidden ? "hidden" : "flex flex-col gap-3"}>
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                {g.color && (
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                )}
                {g.label}
                <span className="text-xs font-normal text-text-subtle">{visibleGroupIds.length}</span>
              </h3>
              <SortableContext items={visibleGroupIds} strategy={verticalListSortingStrategy}>
                {g.items.map(renderRow)}
              </SortableContext>
            </section>
          );
        })
      ) : (
        <SortableContext items={objectiveIds} strategy={verticalListSortingStrategy}>
          {objectives.map(renderRow)}
        </SortableContext>
      )}
    </DndContext>
    </>
  );
}
