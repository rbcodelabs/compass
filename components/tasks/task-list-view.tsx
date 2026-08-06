"use client";

import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TaskLinksBadge } from "./task-links-badge";
import type { TaskCardData } from "./task-card";
import type { MemberData } from "@/lib/types";

type Props = {
  tasks: TaskCardData[];
  orgSlug: string;
  workspaceSlug: string;
  members: MemberData[];
};

function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}

// Flattens the task set into a depth-first order (top-level first, each
// followed immediately by its own children), tagging each row with its
// hierarchy depth so titles can be indented in the table.
function flattenByHierarchy(tasks: TaskCardData[]): { task: TaskCardData; depth: number }[] {
  const byParent = new Map<string | null, TaskCardData[]>();
  for (const task of tasks) {
    const key = task.parentTaskId;
    const list = byParent.get(key) ?? [];
    list.push(task);
    byParent.set(key, list);
  }

  const result: { task: TaskCardData; depth: number }[] = [];
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
    for (const task of children) {
      result.push({ task, depth });
      walk(task.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}

export function TaskListView({ tasks, orgSlug, workspaceSlug, members }: Props) {
  const rows = flattenByHierarchy(tasks);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No tasks match the current filters.</p>;
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 text-xs text-muted-foreground hover:bg-muted/40">
            <TableHead className="px-3 py-2">Title</TableHead>
            <TableHead className="px-3 py-2">Assignee</TableHead>
            <TableHead className="px-3 py-2">Squad</TableHead>
            <TableHead className="px-3 py-2">Priority</TableHead>
            <TableHead className="px-3 py-2">Status</TableHead>
            <TableHead className="px-3 py-2">Due</TableHead>
            <TableHead className="px-3 py-2">Points</TableHead>
            <TableHead className="px-3 py-2">Links</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ task, depth }) => {
            const assigneeMember = task.assigneeUserId ? members.find((m) => m.userId === task.assigneeUserId) : null;
            const assigneeLabel = assigneeMember?.name || assigneeMember?.email || task.ownerName || "—";
            return (
              <TableRow key={task.id} className="hover:bg-muted/30">
                <TableCell className="px-3 py-2" style={{ paddingLeft: `${12 + depth * 20}px` }}>
                  <Link
                    href={`/${orgSlug}/${workspaceSlug}/tasks/${task.id}`}
                    className="font-medium hover:underline underline-offset-2"
                  >
                    {task.title}
                  </Link>
                </TableCell>
                <TableCell className="px-3 py-2 text-muted-foreground">{assigneeLabel}</TableCell>
                <TableCell className="px-3 py-2">
                  {task.squad ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: task.squad.color }} />
                      {task.squad.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="px-3 py-2">
                  <Badge variant="outline">{task.priority}</Badge>
                </TableCell>
                <TableCell className="px-3 py-2">
                  <Badge variant="secondary">{task.status}</Badge>
                </TableCell>
                <TableCell className="px-3 py-2 text-muted-foreground">
                  {task.dueDate ? (
                    <span className="flex items-center gap-1">
                      <CalendarDays className="size-3 shrink-0" />
                      {formatDueDate(task.dueDate)}
                    </span>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="px-3 py-2 text-muted-foreground">{task.storyPoints ?? "—"}</TableCell>
                <TableCell className="px-3 py-2">
                  <TaskLinksBadge count={task.links.length} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
