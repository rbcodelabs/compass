"use client";

import { useRef, useState, useTransition } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import type { TaskCardData } from "./task-card";
import { TaskAssigneePicker } from "./task-assignee-picker";
import type { TaskAssignee } from "@/lib/task-assignment";
import type { MemberData } from "@/lib/types";

type Props = {
  workspaceId: string;
  parentTaskId: string;
  revalidatePathStr: string;
  onAdd: (task: TaskCardData) => void;
  members?: MemberData[];
};

export function AddSubtaskForm({ workspaceId, parentTaskId, revalidatePathStr, onAdd, members = [] }: Props) {
  const [open, setOpen] = useState(false);
  const [assignee, setAssignee] = useState<TaskAssignee>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const title = (data.get("title") as string).trim();
    if (!title) return;
    setError(null);
    startTransition(async () => {
      try {
      const task = await addTask(workspaceId, { title, parentTaskId, assignee }, revalidatePathStr);
      onAdd({
        id: task.id,
        title: task.title,
        description: task.description ?? null,
        status: task.status as TaskCardData["status"],
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
      setAssignee(null);
      formRef.current?.reset();
      } catch (error) { setError(error instanceof Error ? error.message : "Could not add the subtask. Please retry."); }
    });
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs font-medium text-text-subtle hover:text-primary transition-colors"
      >
        <PlusIcon className="w-3.5 h-3.5" />
        Add subtask
      </button>
    );
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2">
      <Input name="title" placeholder="Subtask title" autoFocus required disabled={isPending} className="h-8 text-sm" />
      <TaskAssigneePicker members={members} value={assignee} onChange={setAssignee} disabled={isPending} />
      <Button type="submit" size="sm" disabled={isPending}>
        {isPending ? "Adding..." : "Add"}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
