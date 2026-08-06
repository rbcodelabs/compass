"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TaskCard, type TaskCardData } from "./task-card";
import { AddTaskForm } from "./add-task-form";
import type { TaskStatus, MemberData } from "@/lib/types";
import { BoardColumn, EmptyState } from "@/components/patterns";

export const STATUS_CONFIG: Record<TaskStatus, { label: string; accentClass: string; emptyText: string }> = {
  BACKLOG: { label: "Backlog", accentClass: "bg-slate-400", emptyText: "Nothing in the backlog." },
  TODO: { label: "To Do", accentClass: "bg-sky-500", emptyText: "Nothing queued up yet." },
  IN_PROGRESS: { label: "In Progress", accentClass: "bg-blue-500", emptyText: "Nothing in progress." },
  BLOCKED: { label: "Blocked", accentClass: "bg-red-500", emptyText: "Nothing blocked." },
  IN_REVIEW: { label: "In Review", accentClass: "bg-amber-500", emptyText: "Nothing in review." },
  DONE: { label: "Done", accentClass: "bg-emerald-500", emptyText: "Nothing done yet." },
  CANCELLED: { label: "Cancelled", accentClass: "bg-slate-300", emptyText: "Nothing cancelled." },
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
  onUpdate: (task: TaskCardData) => void;
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
  onUpdate,
}: Props) {
  const { label, emptyText } = STATUS_CONFIG[status];
  const accent = ({ BACKLOG: "neutral", TODO: "info", IN_PROGRESS: "info", BLOCKED: "danger", IN_REVIEW: "warning", DONE: "success", CANCELLED: "neutral" } as const)[status];
  const taskIds = tasks.map((t) => t.id);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}`, data: { status } });

  return (
    <BoardColumn data-task-column={status} title={label} count={tasks.length} accent={accent} className="min-w-[280px] flex-1" bodyRef={setNodeRef} bodyId={`task-column-${status}`} bodyClassName={isOver ? "min-h-44 rounded-lg bg-primary/5 ring-2 ring-inset ring-ring/25" : "min-h-44"} footer={<AddTaskForm workspaceId={workspaceId} status={status} revalidatePathStr={revalidatePathStr} members={members} onAdd={onTaskAdded} />}>
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
                onUpdate={onUpdate}
              />
            ))
          )}
        </SortableContext>
    </BoardColumn>
  );
}
