"use client";

import { useState, useTransition, useCallback } from "react";
import {
  DndContext,
  DragOverlay,
  DragStartEvent,
  DragEndEvent,
  DragOverEvent,
  closestCenter,
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
import { Board } from "@/components/patterns/board";

type ColumnMap = Record<TaskStatus, TaskCardData[]>;

const BOARD_STATUSES: TaskStatus[] = ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"];
const ALL_STATUSES: TaskStatus[] = [...BOARD_STATUSES, "CANCELLED"];

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

export function TaskBoard({ initialTasks, workspaceId, orgSlug, workspaceSlug, members }: Props) {
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/tasks`;

  const [columns, setColumns] = useState<ColumnMap>(() => buildColumnMap(initialTasks));
  const [activeTask, setActiveTask] = useState<TaskCardData | null>(null);
  const [dragSourceStatus, setDragSourceStatus] = useState<TaskStatus | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const visibleStatuses = showCancelled ? ALL_STATUSES : BOARD_STATUSES;

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

    const currentStatus = findStatus(columns, activeId);
    if (!currentStatus) {
      setDragSourceStatus(null);
      return;
    }

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
          await updateSortOrder(activeId, newIndex, revalidatePathStr);
        });
      }
    }

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
  }, []);

  function handleTaskAdded(task: TaskCardData) {
    setColumns((prev) => ({ ...prev, [task.status]: [...prev[task.status], task] }));
  }

  const handleUpdate = useCallback((updated: TaskCardData) => {
    setColumns((prev) => ({
      ...prev,
      [updated.status]: prev[updated.status].map((t) => (t.id === updated.id ? updated : t)),
    }));
  }, []);

  const cancelledCount = columns.CANCELLED.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      {cancelledCount > 0 && (
        <button
          onClick={() => setShowCancelled((v) => !v)}
          className="mx-3 mt-3 self-start flex shrink-0 items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-slate-600 sm:mx-4"
        >
          {showCancelled ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
          {showCancelled ? "Hide" : "Show"} cancelled ({cancelledCount})
        </button>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <Board
          label="Task board"
          className="block min-h-[24rem] flex-1 scroll-px-3 overflow-x-auto p-0 sm:scroll-px-4 md:overflow-y-hidden"
        >
          <div
            data-slot="task-board-track"
            className="flex h-full w-max min-w-full items-stretch gap-3 px-3 pt-3 pb-3 sm:px-4 sm:pt-4 md:px-4 md:pt-3"
          >
            {visibleStatuses.map((status) => (
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
                onUpdate={handleUpdate}
              />
            ))}
          </div>
        </Board>

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
