"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Combobox,
  ComboboxContent,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";
import { updateTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import type { TaskCardData } from "./task-card";
import type { TaskPriority, MemberData } from "@/lib/types";

const PRIORITIES: TaskPriority[] = ["URGENT", "HIGH", "MEDIUM", "LOW"];

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

type Props = {
  task: TaskCardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  revalidatePathStr: string;
  members: MemberData[];
  onSaved: (task: TaskCardData) => void;
};

export function EditTaskDialog({ task, open, onOpenChange, revalidatePathStr, members, onSaved }: Props) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(task.priority);
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(task.assigneeUserId);
  const [ownerName, setOwnerName] = useState(task.ownerName ?? "");
  const [storyPoints, setStoryPoints] = useState(task.storyPoints != null ? String(task.storyPoints) : "");
  const [dueDate, setDueDate] = useState(toDateInputValue(task.dueDate));
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setTitle(task.title);
      setDescription(task.description ?? "");
      setPriority(task.priority);
      setAssigneeUserId(task.assigneeUserId);
      setOwnerName(task.ownerName ?? "");
      setStoryPoints(task.storyPoints != null ? String(task.storyPoints) : "");
      setDueDate(toDateInputValue(task.dueDate));
    }
  }, [open, task]);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;

    startTransition(async () => {
      const updated = await updateTask(
        task.id,
        {
          title: trimmedTitle,
          description: description.trim() || null,
          priority,
          assigneeUserId,
          ownerName: ownerName.trim() || null,
          storyPoints: storyPoints ? parseFloat(storyPoints) : null,
          dueDate: dueDate ? new Date(dueDate) : null,
        },
        revalidatePathStr
      );

      onSaved({
        ...task,
        title: updated.title,
        description: updated.description ?? null,
        priority: updated.priority as TaskPriority,
        assigneeUserId: updated.assigneeUserId ?? null,
        ownerName: updated.ownerName ?? null,
        storyPoints: updated.storyPoints ?? null,
        dueDate: updated.dueDate ? updated.dueDate.toISOString() : null,
      });
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit task</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-task-title-${task.id}`}>Title</Label>
            <Input
              id={`edit-task-title-${task.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              disabled={isPending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-task-description-${task.id}`}>Description</Label>
            <Textarea
              id={`edit-task-description-${task.id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isPending}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`edit-task-priority-${task.id}`}>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)} disabled={isPending}>
                <SelectTrigger id={`edit-task-priority-${task.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`edit-task-points-${task.id}`}>Story points</Label>
              <Input
                id={`edit-task-points-${task.id}`}
                type="number"
                min={0}
                step="0.5"
                value={storyPoints}
                onChange={(e) => setStoryPoints(e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-task-assignee-${task.id}`}>Assignee</Label>
            <Combobox
              items={[
                { value: "__none__", label: "— None —" },
                ...members.map((m) => ({ value: m.userId, label: m.name || m.email })),
              ]}
              value={assigneeUserId ?? "__none__"}
              onValueChange={(v) => setAssigneeUserId(v === "__none__" ? null : v)}
              disabled={isPending}
            >
              <ComboboxTrigger id={`edit-task-assignee-${task.id}`}>
                <ComboboxValue placeholder="Unassigned" />
              </ComboboxTrigger>
              <ComboboxContent />
            </Combobox>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-task-owner-${task.id}`}>Owner name (external stakeholder)</Label>
            <Input
              id={`edit-task-owner-${task.id}`}
              placeholder="e.g. Jane from Marketing"
              value={ownerName}
              onChange={(e) => setOwnerName(e.target.value)}
              disabled={isPending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`edit-task-due-${task.id}`}>Due date</Label>
            <Input
              id={`edit-task-due-${task.id}`}
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={isPending}
            />
          </div>

          <DialogFooter>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
