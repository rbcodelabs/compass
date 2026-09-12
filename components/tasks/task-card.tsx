"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, CalendarDays, Layers } from "lucide-react";
import { EntityCard } from "@/components/patterns/entity-card";
import { StatusBadge } from "@/components/patterns/status-badge";
import { CardMenu } from "@/components/ui/card-menu";
import { Badge } from "@/components/ui/badge";
import { cancelTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions";
import { EditTaskDialog } from "./edit-task-dialog";
import { TaskLinksBadge } from "./task-links-badge";
import { UNASSIGNED_ASSIGNEE_CLASS, taskAssigneeDisplay } from "@/lib/task-assignee-display";
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
  assigneeAgentId?: string | null;
  assignee?: import("@/lib/task-assignment").ResolvedTaskAssignee | null;
  ownerName: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  iteration: string | null;
  parentTaskId: string | null;
  subtaskCount: number;
  links: { id: string; linkedType: TaskLinkedType; linkedId: string; linkedTitle: string }[];
};

const PRIORITY_STATUS: Record<TaskPriority, "danger" | "warning" | "info" | "neutral"> = {
  URGENT: "danger",
  HIGH: "warning",
  MEDIUM: "info",
  LOW: "neutral",
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

  const assignee = taskAssigneeDisplay(task, members);
  const dueLabel = formatDueDate(task.dueDate);
  const detailHref = `/${orgSlug}/${workspaceSlug}/tasks/${task.id}`;

  return (
    <div ref={setNodeRef} style={style} className="touch-none group">
      <EntityCard
        interactive
        className="w-full p-3 data-[dragging=true]:shadow-[var(--shadow-panel)] data-[dragging=true]:ring-2 data-[dragging=true]:ring-ring/30"
        data-dragging={isDragging ? true : undefined}
        leading={
          <button
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            className="shrink-0 cursor-grab touch-none rounded text-text-subtle/60 hover:text-text-subtle active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-focus"
            aria-label="Drag to reorder"
          >
            <GripVertical className="size-3.5" />
          </button>
        }
        title={<Link href={detailHref} className="hover:underline underline-offset-2">{task.title}</Link>}
        description={task.description}
        actions={
          <CardMenu
            items={[
              { label: "Edit", onClick: () => setEditOpen(true) },
              { label: "Cancel", onClick: () => handleCancel(), destructive: true },
            ]}
          />
        }
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={PRIORITY_STATUS[task.priority]}>{task.priority}</StatusBadge>
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
            <span className={`truncate max-w-[140px] ${assignee.assigned ? "" : UNASSIGNED_ASSIGNEE_CLASS}`}>
              {assignee.label}
            </span>
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
        </div>
      </EntityCard>

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
