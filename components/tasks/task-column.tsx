"use client";

import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TaskCard, type TaskCardData } from "./task-card";
import { AddTaskForm } from "./add-task-form";
import type { TaskStatus, MemberData } from "@/lib/types";

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
  const { label, accentClass, emptyText } = STATUS_CONFIG[status];
  const taskIds = tasks.map((t) => t.id);

  const { setNodeRef, isOver } = useDroppable({ id: `column-${status}`, data: { status } });

  return (
    <div className="flex flex-col gap-2 min-w-[280px] flex-1" data-task-column={status}>
      <div className="flex items-center gap-2 px-1 mb-1">
        <div className={`w-2 h-2 rounded-full shrink-0 ${accentClass}`} aria-hidden="true" />
        <span className="text-sm font-semibold text-slate-700">{label}</span>
        <span className="ml-auto text-xs font-medium text-slate-400 bg-slate-200/60 rounded-full px-2 py-0.5 tabular-nums">
          {tasks.length}
        </span>
      </div>

      <div
        ref={setNodeRef}
        id={`task-column-${status}`}
        className={[
          "flex flex-col gap-2 min-h-[180px] rounded-xl p-2.5 transition-colors",
          isOver ? "bg-indigo-50/80 ring-2 ring-inset ring-indigo-200" : "bg-slate-100/80",
        ].join(" ")}
      >
        <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
          {tasks.length === 0 ? (
            <div
              className={[
                "flex items-center justify-center flex-1 min-h-[120px] rounded-lg border border-dashed py-8 text-xs text-center text-slate-400 px-4 transition-colors",
                isOver ? "border-indigo-300" : "border-slate-300/70",
              ].join(" ")}
            >
              {emptyText}
            </div>
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
      </div>

      <AddTaskForm
        workspaceId={workspaceId}
        status={status}
        revalidatePathStr={revalidatePathStr}
        members={members}
        onAdd={onTaskAdded}
      />
    </div>
  );
}
