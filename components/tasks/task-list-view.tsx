"use client";

import { useEffect, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { usePanelContext } from "@/components/panels/panel-context";
import { TaskLinksBadge } from "./task-links-badge";
import { UNASSIGNED_ASSIGNEE_CLASS, taskAssigneeDisplay } from "@/lib/task-assignee-display";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "@/lib/task-meta";
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
  const taskIds = new Set(tasks.map((task) => task.id));
  const byParent = new Map<string | null, TaskCardData[]>();
  for (const task of tasks) {
    const key = task.parentTaskId;
    const list = byParent.get(key) ?? [];
    list.push(task);
    byParent.set(key, list);
  }

  const result: { task: TaskCardData; depth: number }[] = [];
  function walk(parentId: string, depth: number) {
    const children = (byParent.get(parentId) ?? []).sort((a, b) => a.sortOrder - b.sortOrder);
    for (const task of children) {
      result.push({ task, depth });
      walk(task.id, depth + 1);
    }
  }

  const roots = tasks
    .filter((task) => task.parentTaskId === null || !taskIds.has(task.parentTaskId))
    .sort((a, b) => a.sortOrder - b.sortOrder);
  for (const task of roots) {
    result.push({ task, depth: 0 });
    walk(task.id, 1);
  }
  return result;
}

export function TaskListView({ tasks: initialTasks, members }: Props) {
  const { openPanel, subscribeEntityMutated } = usePanelContext();
  const [tasks, setTasks] = useState(initialTasks);

  // Re-sync when the server hands down a fresh list (e.g. a filter change).
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  // The panel (PanelShell) is a layout sibling of this list, not a child, so
  // an edit made there reaches this table's own local state via the
  // notify/subscribe escape hatch — same pattern TaskBoard.handleUpdate uses.
  useEffect(() => {
    return subscribeEntityMutated("task", (_id, patch) => {
      const updated = patch?.task;
      if (!updated) return;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    });
  }, [subscribeEntityMutated]);

  const rows = flattenByHierarchy(tasks);

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No tasks match the current filters.</p>;
  }

  return (
    // `min-h-0` + `overflow-y-auto` (not `overflow-hidden`) make this div the
    // actual scroll viewport inside `WorkspacePage`'s `md:overflow-hidden`
    // content area — see the matching fix/comment in discovery-table-view.tsx.
    // `overflow-hidden` here silently clipped rows and the table's own
    // horizontal scrollbar past the fold with no way to reach them.
    <div
      data-testid="task-list-scroll"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-xl border border-border"
    >
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
            const assignee = taskAssigneeDisplay(task, members);
            return (
              <TableRow key={task.id} className="hover:bg-muted/30">
                <TableCell className="px-3 py-2" style={{ paddingLeft: `${12 + depth * 20}px` }}>
                  <button
                    type="button"
                    onClick={() => openPanel("task", task.id)}
                    className="text-left font-medium hover:underline underline-offset-2"
                  >
                    {task.title}
                  </button>
                </TableCell>
                <TableCell className="px-3 py-2 text-muted-foreground">
                  <span className={assignee.assigned ? undefined : UNASSIGNED_ASSIGNEE_CLASS}>{assignee.label}</span>
                </TableCell>
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
                  <Badge variant="outline">{TASK_PRIORITY_LABELS[task.priority]}</Badge>
                </TableCell>
                <TableCell className="px-3 py-2">
                  <Badge variant="secondary">{TASK_STATUS_LABELS[task.status]}</Badge>
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
