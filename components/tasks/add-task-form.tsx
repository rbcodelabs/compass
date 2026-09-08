"use client";

import { useState, useTransition, useRef } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TaskAssigneePicker } from "./task-assignee-picker";
import type { TaskAssignee } from "@/lib/task-assignment";
import { addTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import type { TaskCardData } from "./task-card";
import type { TaskStatus, MemberData } from "@/lib/types";

type Props = {
  workspaceId: string;
  status: TaskStatus;
  revalidatePathStr: string;
  members: MemberData[];
  onAdd: (task: TaskCardData) => void;
};

export function AddTaskForm({ workspaceId, status, revalidatePathStr, members, onAdd }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [assignee, setAssignee] = useState<TaskAssignee>(null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function reset() {
    setAssignee(null);
    formRef.current?.reset();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = (data.get("title") as string).trim();
    if (!title) return;
    setError(null);
    startTransition(async () => {
      try {
      const task = await addTask(
        workspaceId,
        { title, status, assignee },
        revalidatePathStr
      );

      onAdd({
        id: task.id,
        title: task.title,
        description: task.description ?? null,
        status: task.status as TaskStatus,
        priority: task.priority as TaskCardData["priority"],
        sortOrder: task.sortOrder,
        squadId: null,
        squad: null,
        assigneeUserId: task.assigneeUserId ?? null,
        assigneeAgentId: task.assigneeAgentId ?? null,
        assignee: task.assignee,
        ownerName: task.ownerName ?? null,
        storyPoints: task.storyPoints ?? null,
        dueDate: task.dueDate ? task.dueDate.toISOString() : null,
        iteration: task.iteration ?? null,
        parentTaskId: task.parentTaskId ?? null,
        subtaskCount: 0,
        links: [],
      });
      setOpen(false);
      reset();
      } catch (error) { setError(error instanceof Error ? error.message : "Could not add the task. Please retry."); }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 w-full rounded-lg px-2.5 py-2 text-xs font-medium text-text-subtle hover:text-indigo-600 hover:bg-surface-panel/70 transition-all duration-150"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add task
      </button>
    );
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="rounded-xl ring-1 ring-border bg-muted/30 p-3 flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`task-title-${status}`}>Title</Label>
        <Input
          id={`task-title-${status}`}
          name="title"
          placeholder="What needs doing?"
          autoFocus
          required
          disabled={isPending}
        />
      </div>

      {members.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`task-assignee-${status}`}>Assignee (optional)</Label>
          <TaskAssigneePicker id={`task-assignee-${status}`} members={members} value={assignee} onChange={setAssignee} disabled={isPending} />
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Adding..." : "Add Task"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            reset();
          }}
        >
          Cancel
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
