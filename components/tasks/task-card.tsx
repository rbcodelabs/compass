"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, CalendarDays, Layers } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CardMenu } from "@/components/ui/card-menu";
import { Badge } from "@/components/ui/badge";
import { cancelTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { EditTaskDialog } from "./edit-task-dialog";
import { TaskLinksBadge } from "./task-links-badge";
import type { TaskStatus, TaskPriority, TaskLinkedType } from "@/lib/types";
import type { MemberData } from "@/lib/types";

export type TaskCardData = {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  sortOrder: number;
  squadId: string | null;
  squad: { id: string; name: string; color: string } | null;
  assigneeUserId: string | null;
  ownerName: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  iteration: string | null;
  parentTaskId: string | null;
  subtaskCount: number;
  links: { id: string; linkedType: TaskLinkedType; linkedId: string; linkedTitle: string }[];
};

const PRIORITY_STYLES: Record<TaskPriority, string> = {
  URGENT: "bg-red-50 text-red-600",
  HIGH: "bg-orange-50 text-orange-600",
  MEDIUM: "bg-blue-50 text-blue-600",
  LOW: "bg-slate-100 text-slate-500",
};

function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

type Props = {
  task: TaskCardData;
  revalidatePathStr: string;
  orgSlug: string;
  workspaceSlug: string;
  members: MemberData[];
  onCancel: (taskId: string) => void;
  onUpdate?: (task: TaskCardData) => void;
};

export function TaskCard({ task, revalidatePathStr, orgSlug, workspaceSlug, members, onCancel, onUpdate }: Props) {
  const [, startCancelTransition] = useTransition();
  const [editOpen, setEditOpen] = useState(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id, data: { status: task.status } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  function handleCancel() {
    onCancel(task.id);
    startCancelTransition(async () => {
      await cancelTask(task.id, revalidatePathStr);
    });
  }

  const assigneeMember = task.assigneeUserId ? members.find((m) => m.userId === task.assigneeUserId) : null;
  const assigneeLabel = assigneeMember?.name || assigneeMember?.email || task.ownerName || null;
  const dueLabel = formatDueDate(task.dueDate);
  const detailHref = `/${orgSlug}/${workspaceSlug}/tasks/${task.id}`;

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <Card
        size="sm"
        className="w-full bg-white shadow-sm transition-all duration-150 data-[dragging=true]:shadow-xl data-[dragging=true]:ring-2 data-[dragging=true]:ring-indigo-200"
        data-dragging={isDragging ? true : undefined}
      >
        <CardHeader className="flex-row items-start gap-2 pr-2">
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="mt-0.5 shrink-0 cursor-grab touch-none text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>

          <CardTitle className="flex-1 text-sm leading-snug">
            <Link href={detailHref} className="hover:underline underline-offset-2">
              {task.title}
            </Link>
          </CardTitle>

          <CardMenu
            items={[
              { label: "Edit", onClick: () => setEditOpen(true) },
              { label: "Cancel", onClick: () => handleCancel(), destructive: true },
            ]}
          />
        </CardHeader>

        <CardContent className="flex flex-col gap-2 pt-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_STYLES[task.priority]}`}>
              {task.priority}
            </span>
            {task.squad && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: task.squad.color }} />
                {task.squad.name}
              </span>
            )}
            {task.storyPoints != null && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {task.storyPoints} pt{task.storyPoints === 1 ? "" : "s"}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
            {assigneeLabel && <span className="truncate max-w-[140px]">{assigneeLabel}</span>}
            {dueLabel && (
              <span className="flex items-center gap-1">
                <CalendarDays className="size-3 shrink-0" />
                {dueLabel}
              </span>
            )}
            {task.subtaskCount > 0 && (
              <span className="flex items-center gap-1">
                <Layers className="size-3 shrink-0" />
                {task.subtaskCount} subtask{task.subtaskCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          <TaskLinksBadge count={task.links.length} className="self-start" />
        </CardContent>
      </Card>

      <EditTaskDialog
        task={task}
        open={editOpen}
        onOpenChange={setEditOpen}
        revalidatePathStr={revalidatePathStr}
        members={members}
        onSaved={(updated) => onUpdate?.(updated)}
      />
    </div>
  );
}
