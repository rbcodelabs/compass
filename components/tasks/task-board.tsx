"use client";

import { useState, useTransition, useCallback, useEffect, useId, useRef } from "react";
import {
  DndContext,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
  DragCancelEvent,
  DragOverEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  sortableKeyboardCoordinates,
  arrayMove,
} from "@dnd-kit/sortable";
import { EyeOffIcon, EyeIcon } from "lucide-react";
import { moveTaskStatus, updateSortOrder } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { TaskColumn } from "./task-column";
import { TaskCard, type TaskCardData } from "./task-card";
import type { TaskStatus, MemberData } from "@/lib/types";
import {
  Board,
  BOARD_FADE_END_TRACK_CLASS,
  BoardDock,
  type BoardColumnLayoutControls,
  type BoardDockTab,
} from "@/components/patterns/board";
import { DroppableDockTab, dockAwareCollisionDetection } from "@/components/patterns/board-dock-dnd";
import { useTasksColumnLayout } from "@/components/tasks/tasks-column-layout";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";
import { canMoveColumn, collapseDock, moveColumn, setActiveColumn, togglePinColumn, type BoardLayout, type MoveDirection } from "@/lib/board-layout";
import { TASK_BOARD_COLUMN_IDS, TASK_BOARD_STATUSES } from "@/lib/tasks/board-layout";
import { TASK_STATUS_LABELS } from "@/lib/task-meta";
import { dockTabDropStatus } from "@/lib/discovery-board-ordering";
import { usePanelContext } from "@/components/panels/panel-context";
import { TASK_CREATED_EVENT } from "@/lib/task-created-event";
import { useLiveRefresh } from "@/hooks/use-live-refresh";
import { useServerSyncedState } from "@/hooks/use-server-synced-state";
import { useFlipAnimation } from "@/hooks/use-flip-animation";

type ColumnMap = Record<TaskStatus, TaskCardData[]>;

const BOARD_STATUSES: readonly TaskStatus[] = TASK_BOARD_STATUSES;
const ALL_STATUSES = TASK_BOARD_COLUMN_IDS as readonly TaskStatus[];

type Props = {
  initialTasks: TaskCardData[];
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  members: MemberData[];
};

function buildColumnMap(tasks: TaskCardData[]): ColumnMap {
  const map = {} as ColumnMap;
  for (const status of ALL_STATUSES) {
    map[status] = tasks.filter((t) => t.status === status).sort((a, b) => a.sortOrder - b.sortOrder);
  }
  return map;
}

function findStatus(columns: ColumnMap, taskId: string): TaskStatus | null {
  for (const status of ALL_STATUSES) {
    if (columns[status].some((t) => t.id === taskId)) return status;
  }
  return null;
}

/**
 * Columns are local state so drag-and-drop and the other card edits can move
 * cards optimistically, and they follow `initialTasks` whenever the server data
 * changes (another user or an agent moved a task; see useServerSyncedState and
 * useLiveRefresh). Server data is adopted only while the board is idle - no drag
 * and no local write in flight - so a revalidation can never snap back an
 * optimistic move.
 *
 * The page still keys the board on the active filters (`taskBoardFilterKey`),
 * which remounts it on a filter change; that stays correct and also resets
 * view state such as the "show cancelled" toggle.
 */
export function TaskBoard({ initialTasks, workspaceId, orgSlug, workspaceSlug, members }: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/tasks`;
  const { subscribeEntityMutated } = usePanelContext();

  const [activeTask, setActiveTask] = useState<TaskCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<TaskStatus | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const [isPending, startTransition] = useTransition();

  const busy = activeTask !== null || dragSourceStatus !== null || isPending;
  const {
    state: columns,
    setState: setColumns,
    generation,
  } = useServerSyncedState(initialTasks, buildColumnMap, busy);
  const { containerRef, capture } = useFlipAnimation(generation);
  useLiveRefresh({ orgSlug, workspaceSlug, scope: "tasks", paused: busy, onBeforeRefresh: capture });

  // Stable across server and client; without it @dnd-kit numbers its
  // aria-describedby ids from a global counter and hydration mismatches.
  const dndId = useId();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Column layout (lib/board-layout.ts): the column order, which columns are pinned (docked in ONE dock on the right,
  // outside the scroller), which pinned column the dock shows and whether it is collapsed to its tab rail. Docking applies
  // from md up only; below md every column is an ordinary scroller column, in the same order. "Show cancelled" changes the
  // column set: a hidden CANCELLED is filtered out of what renders (the layout keeps it, pinned or not).
  const isDesktop = useMediaQuery("(min-width: 768px)", false);
  const { layout, update: updateLayout } = useTasksColumnLayout(workspaceId);
  const visibleStatuses = showCancelled ? ALL_STATUSES : BOARD_STATUSES;
  const rendered = new Set<string>(visibleStatuses);
  const orderedStatuses = layout.columnOrder.filter((id) => rendered.has(id)) as TaskStatus[];
  const isDocked = (id: string) => isDesktop && layout.pinnedColumnIds.includes(id);
  const dockedStatuses = orderedStatuses.filter(isDocked);
  const scrollerStatuses = orderedStatuses.filter((id) => !isDocked(id));
  // The stored active column may be one that isn't rendered (a hidden CANCELLED): show the first rendered one then.
  const activeDockId = layout.activePinnedId && dockedStatuses.includes(layout.activePinnedId as TaskStatus) ? (layout.activePinnedId as TaskStatus) : (dockedStatuses[0] ?? null);
  const dockOpen = activeDockId !== null && !layout.dockCollapsed;

  // Keyboard users keep their place: after a layout change the control that now represents the column gets focus.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    containerRef.current?.querySelector<HTMLElement>(`[data-column-control="${target}"]`)?.focus();
  }, [layout, containerRef]);
  const changeLayout = (transition: (current: BoardLayout) => BoardLayout, focus?: string) => {
    if (focus) pendingFocus.current = focus;
    updateLayout(transition);
  };

  // The active tab of an open dock closes it; any other tab shows its column and opens the dock.
  function selectDockTab(id: string) {
    changeLayout((current) => (dockOpen && id === activeDockId ? collapseDock(current) : setActiveColumn(current, id)), `${id}:tab`);
  }

  function layoutControlsFor(status: TaskStatus): BoardColumnLayoutControls {
    // A column moves among the columns rendered in its own region (the dock's tabs, or the scroller; everything on narrow screens).
    const scope = { among: (other: string) => rendered.has(other) && (!isDesktop || isDocked(other) === isDocked(status)) };
    const docked = isDocked(status);
    return {
      columnId: status,
      label: TASK_STATUS_LABELS[status],
      pinned: docked,
      pinnable: isDesktop,
      onTogglePin: () => changeLayout((l) => togglePinColumn(l, status), `${status}:pin`),
      canMoveLeft: canMoveColumn(layout, status, "left", scope),
      canMoveRight: canMoveColumn(layout, status, "right", scope),
      onMove: (direction: MoveDirection) => changeLayout((l) => moveColumn(l, status, direction, scope), `${status}:menu`),
      onCollapse: docked ? () => changeLayout(collapseDock, `${status}:tab`) : undefined,
    };
  }

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    for (const status of ALL_STATUSES) {
      const found = columns[status].find((t) => t.id === id);
      if (found) {
        setActiveTask(found);
        setDragSourceStatus(status);
        return;
      }
    }
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    // A dock tab is resolved at drag end: its column may not be rendered, and moving the dragged card into an unrendered
    // column mid-drag unmounts it (and its menu) while dnd-kit is still tracking it.
    if (dockTabDropStatus(over.data.current)) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    const sourceStatus = findStatus(columns, activeId);
    if (!sourceStatus) return;

    let destStatus: TaskStatus;
    if (overId.startsWith("column-")) {
      destStatus = overId.replace("column-", "") as TaskStatus;
    } else {
      destStatus = findStatus(columns, overId) ?? sourceStatus;
    }

    if (sourceStatus === destStatus) return;

    setColumns((prev) => {
      const task = prev[sourceStatus].find((t) => t.id === activeId);
      if (!task) return prev;
      const updatedTask = { ...task, status: destStatus };

      let destItems = prev[destStatus].filter((t) => t.id !== activeId);
      if (!overId.startsWith("column-")) {
        const overIndex = destItems.findIndex((t) => t.id === overId);
        destItems =
          overIndex >= 0
            ? [...destItems.slice(0, overIndex), updatedTask, ...destItems.slice(overIndex)]
            : [...destItems, updatedTask];
      } else {
        destItems = [...destItems, updatedTask];
      }

      return {
        ...prev,
        [sourceStatus]: prev[sourceStatus].filter((t) => t.id !== activeId),
        [destStatus]: destItems,
      };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) {
      setDragSourceStatus(null);
      return;
    }

    const activeId = active.id as string;
    const overId = over.id as string;

    const found = findStatus(columns, activeId);
    if (!found) {
      setDragSourceStatus(null);
      return;
    }

    // Dropped on a dock tab: that tab's status is the destination (the card was not moved there during the drag).
    const tabStatus = dockTabDropStatus<TaskStatus>(over.data.current);
    if (tabStatus) {
      if (tabStatus !== found) {
        setColumns((prev) => {
          const task = prev[found].find((t) => t.id === activeId);
          if (!task) return prev;
          return { ...prev, [found]: prev[found].filter((t) => t.id !== activeId), [tabStatus]: [...prev[tabStatus], { ...task, status: tabStatus }] };
        });
        startTransition(async () => {
          await moveTaskStatus(activeId, tabStatus, workspaceId, revalidatePathStr);
        });
      }
      setDragSourceStatus(null);
      return;
    }
    const currentStatus = found;

    if (dragSourceStatus && dragSourceStatus !== currentStatus) {
      startTransition(async () => {
        await moveTaskStatus(activeId, currentStatus, workspaceId, revalidatePathStr);
      });
    } else if (!overId.startsWith("column-") && overId !== activeId) {
      const columnItems = columns[currentStatus];
      const oldIndex = columnItems.findIndex((t) => t.id === activeId);
      const newIndex = columnItems.findIndex((t) => t.id === overId);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(columnItems, oldIndex, newIndex).map((t, idx) => ({ ...t, sortOrder: idx }));
        setColumns((prev) => ({ ...prev, [currentStatus]: reordered }));

        startTransition(async () => {
          await updateSortOrder(activeId, reordered.map(({ id }) => id), revalidatePathStr);
        });
      }
    }

    setDragSourceStatus(null);
  }

  /** Escape (or anything else that cancels the drag) puts the card back where the drag began. */
  function handleDragCancel(event: DragCancelEvent) {
    const activeId = event.active.id as string;
    const found = findStatus(columns, activeId);
    if (dragSourceStatus && found && found !== dragSourceStatus) {
      setColumns((prev) => {
        const task = prev[found].find((t) => t.id === activeId);
        if (!task) return prev;
        return {
          ...prev,
          [found]: prev[found].filter((t) => t.id !== activeId),
          [dragSourceStatus]: [...prev[dragSourceStatus], { ...task, status: dragSourceStatus }],
        };
      });
    }
    setActiveTask(null);
    setDragSourceStatus(null);
  }

  const handleCancel = useCallback((taskId: string) => {
    setColumns((prev) => {
      const cancelledTask = ALL_STATUSES.map((status) => prev[status].find((t) => t.id === taskId)).find(Boolean);

      const next = {} as ColumnMap;
      for (const status of ALL_STATUSES) {
        next[status] = prev[status].filter((t) => t.id !== taskId);
      }
      if (cancelledTask) {
        next.CANCELLED = [...next.CANCELLED, { ...cancelledTask, status: "CANCELLED" as const }];
      }
      return next;
    });
  }, [setColumns]);

  function handleTaskAdded(task: TaskCardData) {
    setColumns((prev) => ({ ...prev, [task.status]: [...prev[task.status], task] }));
  }

  // Status-move-safe: a panel edit can change the task's status (unlike the
  // old EditTaskDialog, which never touched status), so this removes the
  // task from every column and re-adds it to the one matching its current
  // status rather than assuming it's still in the same column.
  const handleUpdate = useCallback((updated: TaskCardData) => {
    setColumns((prev) => {
      const next = {} as ColumnMap;
      for (const status of ALL_STATUSES) {
        next[status] = prev[status].filter((t) => t.id !== updated.id);
      }
      next[updated.status] = [...next[updated.status], updated];
      return next;
    });
  }, [setColumns]);

  // The panel (PanelShell) renders as a layout sibling of TaskBoard, not a
  // child, so edits made there reach this board's own local column state via
  // the notify/subscribe escape hatch — same pattern RoadmapBoard uses.
  useEffect(() => {
    return subscribeEntityMutated("task", (_id, patch) => {
      if (patch?.task) handleUpdate(patch.task);
    });
  }, [subscribeEntityMutated, handleUpdate]);

  // Tasks created from the page header (outside this component) arrive as a window event.
  useEffect(() => {
    function onCreated(event: Event) {
      const task = (event as CustomEvent<TaskCardData>).detail;
      if (!task) return;
      setColumns((prev) =>
        prev[task.status].some((t) => t.id === task.id)
          ? prev
          : { ...prev, [task.status]: [...prev[task.status], task] }
      );
    }
    window.addEventListener(TASK_CREATED_EVENT, onCreated);
    return () => window.removeEventListener(TASK_CREATED_EVENT, onCreated);
  }, [setColumns]);

  const cancelledCount = columns.CANCELLED.length;

  function renderColumn(status: TaskStatus, placement: "scroller" | "pinned") {
    return (
      <TaskColumn
        key={status}
        status={status}
        tasks={columns[status]}
        workspaceId={workspaceId}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        revalidatePathStr={revalidatePathStr}
        members={members}
        onTaskAdded={handleTaskAdded}
        onCancel={handleCancel}
        placement={placement}
        layoutControls={layoutControlsFor(status)}
      />
    );
  }

  const dockTabs: BoardDockTab[] = dockedStatuses.map((status) => ({
    id: status,
    title: TASK_STATUS_LABELS[status],
    count: columns[status].length,
  }));

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      {cancelledCount > 0 && (
        <button
          onClick={() => setShowCancelled((v) => !v)}
          className="mx-3 mt-3 self-start flex shrink-0 items-center gap-1.5 text-xs text-text-subtle transition-colors hover:text-text-secondary sm:mx-4"
        >
          {showCancelled ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
          {showCancelled ? "Hide" : "Show"} cancelled ({cancelledCount})
        </button>
      )}

      <DndContext
        id={dndId}
        sensors={sensors}
        collisionDetection={dockAwareCollisionDetection}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
          <Board
            label="Task board"
            fadeEnd={dockedStatuses.length > 0}
            className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
          >
            <div
              data-slot="task-board-track"
              className={cn(
                "flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3",
                // Room for the scroller's tapered edge, so the last column at full scroll-end is not faded.
                dockedStatuses.length > 0 && BOARD_FADE_END_TRACK_CLASS,
              )}
            >
              {scrollerStatuses.map((status) => renderColumn(status, "scroller"))}
            </div>
          </Board>
          {/* The dock sits OUTSIDE the horizontal scroller, so it stays put while the rest scroll and a drag from it never needs a mid-drag scroll. */}
          {dockTabs.length > 0 ? (
            <BoardDock
              tabs={dockTabs}
              activeId={activeDockId}
              collapsed={!dockOpen}
              onSelectTab={selectDockTab}
              panel={dockOpen && activeDockId ? renderColumn(activeDockId, "pinned") : null}
              wrapTab={(tab, node, { panelOpen }) => (
                <DroppableDockTab columnId={tab.id} columnDroppableId={`column-${tab.id}`} panelOpen={panelOpen} slot="task-dock-tab-drop">
                  {node}
                </DroppableDockTab>
              )}
            />
          ) : null}
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="rotate-1 scale-105">
              <TaskCard
                task={activeTask}
                revalidatePathStr={revalidatePathStr}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                members={members}
                onCancel={() => {}}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
