"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { LinkIcon, PlusIcon } from "lucide-react";
import { addRoadmapDeliveryTask, linkRoadmapDeliveryTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/roadmap-delivery-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Combobox, ComboboxContent, ComboboxTrigger, ComboboxValue } from "@/components/ui/combobox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePanelContext } from "./panel-context";
import type { MemberData, TaskPriority, TaskStatus } from "@/lib/types";

export type RoadmapDeliveryTaskData = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  assigneeUserId: string | null;
  ownerName: string | null;
};

const STATUS: Record<TaskStatus, { label: string; className: string }> = {
  BLOCKED: { label: "Blocked", className: "bg-red-100 text-red-700" },
  IN_REVIEW: { label: "In Review", className: "bg-amber-100 text-amber-700" },
  IN_PROGRESS: { label: "In Development", className: "bg-blue-100 text-blue-700" },
  DONE: { label: "Complete", className: "bg-emerald-100 text-emerald-700" },
  TODO: { label: "Not Started", className: "bg-slate-100 text-slate-600" },
  BACKLOG: { label: "Not Started", className: "bg-slate-100 text-slate-600" },
  CANCELLED: { label: "Cancelled", className: "bg-slate-100 text-slate-500" },
};

type Props = {
  roadmapItemId: string;
  orgSlug: string;
  workspaceSlug: string;
  tasks: RoadmapDeliveryTaskData[];
  linkableTasks: Array<{ id: string; title: string }>;
  members: MemberData[];
  onChanged: () => Promise<void>;
};

export function RoadmapDeliveryTasks({ roadmapItemId, orgSlug, workspaceSlug, tasks, linkableTasks, members, onChanged }: Props) {
  const { notifyEntityMutated } = usePanelContext();
  const [addOpen, setAddOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkTaskId, setLinkTaskId] = useState<string | null>(null);
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function finishMutation() {
    return onChanged().then(() => notifyEntityMutated("roadmapItem", roadmapItemId));
  }

  function handleAdd(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = new FormData(form).get("title")?.toString().trim() ?? "";
    if (!title) return;
    setError(null);
    startTransition(async () => {
      try {
        await addRoadmapDeliveryTask(orgSlug, workspaceSlug, roadmapItemId, { title, assigneeUserId });
        await finishMutation();
        form.reset();
        setAssigneeUserId(null);
        setAddOpen(false);
      } catch {
        setError("Could not add the task. Please try again.");
      }
    });
  }

  function handleLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!linkTaskId) return;
    setError(null);
    startTransition(async () => {
      try {
        await linkRoadmapDeliveryTask(orgSlug, workspaceSlug, roadmapItemId, linkTaskId);
        await finishMutation();
        setLinkTaskId(null);
        setLinkOpen(false);
      } catch {
        setError("Could not link the task. Please try again.");
      }
    });
  }

  const memberName = (task: RoadmapDeliveryTaskData) => {
    const member = task.assigneeUserId ? members.find((candidate) => candidate.userId === task.assigneeUserId) : null;
    return member?.name || member?.email || task.ownerName;
  };

  return (
    <div className="flex flex-col gap-2">
      {tasks.length === 0 ? (
        <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">No active delivery tasks are linked yet.</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Delivery tasks">
          {tasks.map((task) => {
            const assignee = memberName(task);
            return (
              <li key={task.id}>
                <Link href={`/${orgSlug}/${workspaceSlug}/tasks/${task.id}`} className="block rounded-lg border p-2.5 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <span className="block truncate text-sm font-medium">{task.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    <Badge className={STATUS[task.status].className}>{STATUS[task.status].label}</Badge>
                    <span className="text-[11px] capitalize text-muted-foreground">{(task.priority ?? "MEDIUM").toLowerCase()}</span>
                    {assignee && <span className="max-w-32 truncate text-[11px] text-muted-foreground">{assignee}</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {addOpen ? (
        <form onSubmit={handleAdd} className="flex flex-col gap-2 rounded-lg border p-2.5">
          <Label htmlFor={`roadmap-task-title-${roadmapItemId}`}>Task title</Label>
          <Input id={`roadmap-task-title-${roadmapItemId}`} name="title" placeholder="What needs doing?" autoFocus required disabled={isPending} />
          {members.length > 0 && (
            <Combobox items={[{ value: "__none__", label: "Unassigned" }, ...members.map((m) => ({ value: m.userId, label: m.name || m.email }))]} value={assigneeUserId ?? "__none__"} onValueChange={(value) => setAssigneeUserId(value === "__none__" ? null : value)} disabled={isPending}>
              <ComboboxTrigger aria-label="Assignee"><ComboboxValue placeholder="Unassigned" /></ComboboxTrigger>
              <ComboboxContent />
            </Combobox>
          )}
          <div className="flex gap-2"><Button type="submit" size="sm" disabled={isPending}>{isPending ? "Adding…" : "Add task"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => setAddOpen(false)} disabled={isPending}>Cancel</Button></div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => setAddOpen(true)}><PlusIcon className="size-3.5" />Add task</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setLinkOpen(true)} disabled={linkableTasks.length === 0}><LinkIcon className="size-3.5" />Link existing</Button>
        </div>
      )}

      <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
        <DialogContent>
          <form onSubmit={handleLink} className="flex flex-col gap-4">
            <DialogHeader><DialogTitle>Link existing task</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`roadmap-link-task-${roadmapItemId}`}>Task</Label>
              <Combobox items={linkableTasks.map((task) => ({ value: task.id, label: task.title }))} value={linkTaskId} onValueChange={setLinkTaskId} disabled={isPending}>
                <ComboboxTrigger id={`roadmap-link-task-${roadmapItemId}`}><ComboboxValue placeholder="Select a task…" /></ComboboxTrigger><ComboboxContent />
              </Combobox>
            </div>
            <DialogFooter><Button type="submit" size="sm" disabled={isPending || !linkTaskId}>{isPending ? "Linking…" : "Link task"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
