"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { WorkspaceCreateButton } from "@/components/patterns/workspace-header-controls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { addTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { TASK_STATUS_LABELS } from "@/lib/task-meta";
import { dispatchTaskCreated } from "@/lib/task-created-event";
import type { TaskAssignee } from "@/lib/task-assignment";
import type { MemberData, TaskStatus } from "@/lib/types";
import { TaskAssigneePicker } from "./task-assignee-picker";
import type { TaskCardData } from "./task-card";

const CREATE_STATUSES: TaskStatus[] = ["BACKLOG", "TODO", "IN_PROGRESS", "BLOCKED", "IN_REVIEW", "DONE"];

type Props = {
  workspaceId: string;
  orgSlug: string;
  workspaceSlug: string;
  members: MemberData[];
};

/** Tasks' primary header action. Opens a dialog; the board and list pick the new task up without a reload. */
export function CreateTaskDialog({ workspaceId, orgSlug, workspaceSlug, members }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<TaskStatus>("TODO");
  const [assignee, setAssignee] = useState<TaskAssignee>(null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const revalidatePathStr = `/${orgSlug}/${workspaceSlug}/tasks`;

  function reset() {
    setStatus("TODO");
    setAssignee(null);
    setError(null);
    formRef.current?.reset();
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get("title") ?? "").trim();
    if (!title) {
      setError("Title is required");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const task = await addTask(workspaceId, { title, status, assignee }, revalidatePathStr);
        const card: TaskCardData = {
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
        };
        // Board view appends from the event; list view re-syncs from the refreshed server rows.
        dispatchTaskCreated(card);
        router.refresh();
        handleOpenChange(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not add the task. Please retry.");
      }
    });
  }

  return (
    <>
      <WorkspaceCreateButton label="New task" onClick={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton>
          <DialogHeader>
            <DialogTitle>New task</DialogTitle>
          </DialogHeader>
          <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-task-title">Title</Label>
              <Input id="create-task-title" name="title" placeholder="What needs doing?" autoFocus required disabled={isPending} />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-task-status">Status</Label>
              <Select value={status} onValueChange={(v: string | null) => { if (v) setStatus(v as TaskStatus); }} disabled={isPending}>
                <SelectTrigger id="create-task-status" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATE_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>{TASK_STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {members.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-task-assignee">Assignee (optional)</Label>
                <TaskAssigneePicker id="create-task-assignee" members={members} value={assignee} onChange={setAssignee} disabled={isPending} />
              </div>
            )}

            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isPending}>
                {isPending ? "Adding..." : "Add task"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
