"use client";

import { useState, useTransition } from "react";
import { CalendarDays } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { SquadPicker } from "@/components/squads/squad-picker";
import { Markdown } from "@/components/agent/markdown";
import { EditTaskDialog } from "./edit-task-dialog";
import { moveTaskStatus } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { STATUS_CONFIG } from "./task-column";
import { UNASSIGNED_ASSIGNEE_CLASS, taskAssigneeDisplay } from "@/lib/task-assignee-display";
import type { TaskCardData } from "./task-card";
import type { TaskStatus, SquadData, MemberData } from "@/lib/types";

const STATUS_BADGE_CLASSES: Record<TaskStatus, string> = {
  BACKLOG: "bg-surface-inset text-text-secondary border-border-default",
  TODO: "bg-sky-100 text-sky-700 border-sky-200",
  IN_PROGRESS: "bg-blue-100 text-blue-700 border-blue-200",
  BLOCKED: "bg-red-100 text-red-700 border-red-200",
  IN_REVIEW: "bg-amber-100 text-amber-700 border-amber-200",
  DONE: "bg-emerald-100 text-emerald-700 border-emerald-200",
  CANCELLED: "bg-surface-inset text-text-subtle border-border-default",
};

const STATUSES = Object.keys(STATUS_CONFIG) as TaskStatus[];

function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

type Props = {
  task: TaskCardData;
  workspaceId: string;
  squads: SquadData[];
  members: MemberData[];
  revalidatePathStr: string;
};

export function TaskHeader({ task: initialTask, workspaceId, squads, members, revalidatePathStr }: Props) {
  const [task, setTask] = useState(initialTask);
  const [editOpen, setEditOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleStatusChange(value: string | null) {
    if (!value) return;
    const status = value as TaskStatus;
    setTask((prev) => ({ ...prev, status }));
    startTransition(async () => {
      await moveTaskStatus(task.id, status, workspaceId, revalidatePathStr);
    });
  }

  const assignee = taskAssigneeDisplay(task, members);
  const dueLabel = formatDueDate(task.dueDate);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={task.status} onValueChange={handleStatusChange} disabled={isPending}>
          <SelectTrigger
            size="sm"
            className={`w-auto h-6 rounded-full border px-2.5 py-0 text-xs font-medium shadow-none focus-visible:ring-0 [&_svg]:size-3 [&_svg]:opacity-60 ${STATUS_BADGE_CLASSES[task.status]}`}
          >
            {STATUS_CONFIG[task.status].label}
          </SelectTrigger>
          <SelectContent>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_CONFIG[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="inline-flex items-center rounded-full bg-surface-inset text-text-secondary px-2.5 py-0.5 text-xs font-medium border border-border-default">
          {task.priority}
        </span>

        {squads.length > 0 && (
          <SquadPicker
            objectType="task"
            objectId={task.id}
            currentSquadId={task.squadId}
            squads={squads}
            revalidatePathStr={revalidatePathStr}
          />
        )}

        <button
          onClick={() => setEditOpen(true)}
          className="text-xs text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground"
        >
          Edit
        </button>
      </div>

      <h1 className="text-2xl font-bold tracking-tight text-text-primary leading-tight">{task.title}</h1>

      {task.description ? (
        <div className="text-muted-foreground max-w-2xl">
          <Markdown>{task.description}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground/50 italic">No description yet.</p>
      )}

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          Assignee:{" "}
          <span className={assignee.assigned ? undefined : UNASSIGNED_ASSIGNEE_CLASS}>{assignee.label}</span>
        </span>
        {dueLabel && (
          <span className="flex items-center gap-1">
            <CalendarDays className="size-3.5" />
            Due {dueLabel}
          </span>
        )}
        {task.storyPoints != null && <span>{task.storyPoints} story points</span>}
        {task.iteration && <span>Iteration: {task.iteration}</span>}
      </div>

      <EditTaskDialog
        task={task}
        open={editOpen}
        onOpenChange={setEditOpen}
        revalidatePathStr={revalidatePathStr}
        members={members}
        onSaved={(updated) => setTask(updated)}
      />
    </div>
  );
}
