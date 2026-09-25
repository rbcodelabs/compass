"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TaskCard, type TaskCardData } from "./task-card";
import { AddTaskForm } from "./add-task-form";
import type { TaskStatus, MemberData } from "@/lib/types";
import { TASK_STATUS_LABELS } from "@/lib/task-meta";
import { BoardColumn, EmptyState } from "@/components/patterns";

// Labels come from `lib/task-meta.ts` so board columns, list rows and the task
// detail page cannot drift apart; the accent and empty-state copy are
// board-only and stay here.
export const STATUS_CONFIG: Record<TaskStatus, { label: string; accentClass: string; emptyText: string }> = {
  BACKLOG: { label: TASK_STATUS_LABELS.BACKLOG, accentClass: "bg-status-neutral", emptyText: "Nothing in the backlog." },
  TODO: { label: TASK_STATUS_LABELS.TODO, accentClass: "bg-sky-500", emptyText: "Nothing queued up yet." },
  IN_PROGRESS: { label: TASK_STATUS_LABELS.IN_PROGRESS, accentClass: "bg-blue-500", emptyText: "Nothing in progress." },
  BLOCKED: { label: TASK_STATUS_LABELS.BLOCKED, accentClass: "bg-red-500", emptyText: "Nothing blocked." },
  IN_REVIEW: { label: TASK_STATUS_LABELS.IN_REVIEW, accentClass: "bg-amber-500", emptyText: "Nothing in review." },
  DONE: { label: TASK_STATUS_LABELS.DONE, accentClass: "bg-emerald-500", emptyText: "Nothing done yet." },
  CANCELLED: { label: TASK_STATUS_LABELS.CANCELLED, accentClass: "bg-text-disabled", emptyText: "Nothing cancelled." },
};

type Props = {
  status: TaskStatus;
  tasks: TaskCardData[];
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  revalidatePathStr: string;
  members: MemberData[];
  onTaskAdded: (task: TaskCardData) => void;
  onCancel: (taskId: string) => void;
};

export function TaskColumn({
  status,
  tasks,
  workspaceId,
  orgSlug,
  workspaceSlug,
  revalidatePathStr,
  members,
  onTaskAdded,
  onCancel,
}: Props) {
  const { label, emptyText } = STATUS_CONFIG[status];
  const accent = ({ BACKLOG: "neutral", TODO: "info", IN_PROGRESS: "info", BLOCKED: "danger", IN_REVIEW: "warning", DONE: "success", CANCELLED: "neutral" } as const)[status];
  const taskIds = tasks.map((t) => t.id);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}`, data: { status } });

  return (
    <BoardColumn data-task-column={status} title={label} count={tasks.length} accent={accent} className="w-[calc(100cqw-1.5rem)] min-w-0 flex-none sm:w-[calc(100cqw-2rem)] md:w-72 md:min-w-[280px] md:flex-1 md:h-full" bodyRef={setNodeRef} bodyId={`task-column-${status}`} bodyClassName={`min-h-44 md:min-h-0 md:max-h-none md:flex-1 md:overflow-y-auto ${isOver ? "rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : ""}`} footer={<AddTaskForm workspaceId={workspaceId} status={status} revalidatePathStr={revalidatePathStr} members={members} onAdd={onTaskAdded} />}>
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <EmptyState compact title={emptyText} className={isOver ? "border-border-interactive" : undefined} />
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                revalidatePathStr={revalidatePathStr}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
                members={members}
                onCancel={onCancel}
              />
            ))
          )}
        </SortableContext>
    </BoardColumn>
  );
}
