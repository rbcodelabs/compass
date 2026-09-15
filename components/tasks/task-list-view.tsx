"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DataGrid, type GridColumnDef } from "@/components/data-grid";
import { usePanelContext } from "@/components/panels/panel-context";
import { TaskLinksBadge } from "./task-links-badge";
import { UNASSIGNED_ASSIGNEE_CLASS, taskAssigneeDisplay } from "@/lib/task-assignee-display";
import { TASK_PRIORITY_LABELS, TASK_STATUS_LABELS } from "@/lib/task-meta";
import type { TaskCardData } from "./task-card";
import type { MemberData } from "@/lib/types";

type Props = {
  tasks: TaskCardData[];
  /**
   * Accepted but unused, and deliberately still part of the contract: the
   * Tasks page passes both, and a title now opens the shared detail panel
   * rather than navigating to `/{org}/{workspace}/tasks/{id}`, so neither slug
   * is needed to render a row.
   */
  orgSlug: string;
  workspaceSlug: string;
  members: MemberData[];
};

/**
 * One flattened row: a task, the hierarchy depth it renders at, and its
 * resolved assignee label.
 *
 * The assignee is resolved here rather than inside the cell renderer so the
 * column definitions never have to close over `members`. `table.FlexRender`
 * unmounts and remounts a cell's whole subtree whenever the column
 * definition's identity changes (verified directly against 9.1.2), and
 * `members` arrives as a fresh array on every server render — closing over it
 * would tear down and rebuild every cell in the table on each one.
 */
type TaskGridRow = {
  rowKey: string;
  depth: number;
  task: TaskCardData;
  assignee: ReturnType<typeof taskAssigneeDisplay>;
};

// Deliberately distinct from the formatter in `task-card.tsx`, which omits the
// year — a dense card and a wide table row want different amounts of date.
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

  /*
    `openPanel` is NOT referentially stable — it is a `useCallback` over
    `[router, pathname, searchParams]`, and `useSearchParams()` hands back a
    fresh object on plenty of renders. Reading it through a ref keeps it out of
    the column memo's dependency list entirely.

    This is the same hazard the `TaskGridRow` comment above describes for
    `members`, and it bites harder here: a column definition whose identity
    changes makes `table.FlexRender` unmount and remount every cell subtree in
    the table, so every title button would be destroyed and rebuilt on any
    render that produced a new `searchParams` — including the one caused by
    opening a panel.
  */
  const openPanelRef = useRef(openPanel);
  // Synced in an effect, not during render: writing a ref while rendering is a
  // React-compiler lint error, and the value is only ever read from a click
  // handler — which cannot run before the commit that updates it.
  useEffect(() => {
    openPanelRef.current = openPanel;
  }, [openPanel]);

  // Re-sync when the server hands down a fresh list (e.g. a filter change).
  useEffect(() => {
    setTasks(initialTasks);
  }, [initialTasks]);

  /*
    The panel (PanelShell) is a layout sibling of this list, not a child, so an
    edit made there reaches this table's own local state via the
    notify/subscribe escape hatch — same pattern TaskBoard.handleUpdate uses.

    Safe as an effect dependency: `subscribeEntityMutated` is
    `useCallback(..., [])` over a `listenersRef`, so it never changes identity
    and this never tears down and re-subscribes.
  */
  useEffect(() => {
    return subscribeEntityMutated("task", (_id, patch) => {
      const updated = patch?.task;
      if (!updated) return;
      setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    });
  }, [subscribeEntityMutated]);

  const rows = useMemo<TaskGridRow[]>(
    () =>
      flattenByHierarchy(tasks).map(({ task, depth }) => ({
        rowKey: task.id,
        depth,
        task,
        assignee: taskAssigneeDisplay(task, members),
      })),
    [tasks, members],
  );

  // Column definitions stay in this file rather than a sibling `*-columns`
  // module: `scripts/check-ui-colors.mjs` keys its baseline on `file::class`,
  // so moving markup into a new file starts it at a baseline of zero.
  //
  // Every column except Title carries an explicit width. Under `table-fixed`
  // those are authoritative and Title absorbs whatever remains, which is the
  // same shape the Feedback grid uses.
  //
  // Title declares a `minWidth` because "whatever remains" is negative once the
  // other columns (50rem) out-sum the container — measured at 390px, Title
  // painted 0px wide and the column was simply gone. The grid folds this floor
  // into the table's `min-width`, so a narrow viewport scrolls instead of
  // squeezing.
  //
  // 14rem rather than the 18rem Discovery and Feedback use, and the number is
  // load-bearing: Tasks carries the heaviest fixed set of any grid (50rem =
  // 800px), and a 1280px laptop — the narrowest common desktop — leaves this
  // grid a 1026px container, so 226px of headroom. A floor above that would
  // put a horizontal scrollbar on the Tasks page at 1280 where none existed
  // before, trading one regression for another. 14rem (224px) is the largest
  // round value that still fits, and it is comfortably readable even on
  // subtask rows, which lose `depth * 20px` to indentation.
  const columns = useMemo<GridColumnDef<TaskGridRow>[]>(
    () => [
      {
        id: "title",
        header: "Title",
        // `hideable: false` pins Title first and keeps it out of the column
        // menu — a row with no title is not a useful view.
        meta: { label: "Title", hideable: false, minWidth: "14rem" },
        cell: ({ row }) => {
          const { task, depth } = row.original;
          return (
            // Indentation lives on an inner div rather than the `<td>`: the
            // grid's TableCell takes a className, never a style, and encoding
            // depth in the cell's own padding fights its base padding.
            <div
              data-depth={depth}
              className="truncate"
              style={{ paddingLeft: `${depth * 20}px` }}
            >
              <button
                type="button"
                onClick={() => openPanelRef.current("task", task.id)}
                className="max-w-full truncate text-left font-medium hover:underline underline-offset-2"
              >
                {task.title}
              </button>
            </div>
          );
        },
      },
      {
        id: "assignee",
        header: "Assignee",
        meta: { label: "Assignee", width: "9rem", cellClassName: "text-muted-foreground" },
        cell: ({ row }) => {
          const { assignee } = row.original;
          return (
            <span className={assignee.assigned ? undefined : UNASSIGNED_ASSIGNEE_CLASS}>
              {assignee.label}
            </span>
          );
        },
      },
      {
        id: "squad",
        header: "Squad",
        meta: { label: "Squad", width: "8rem" },
        cell: ({ row }) => {
          const { squad } = row.original.task;
          if (!squad) return <span className="text-muted-foreground">—</span>;
          return (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: squad.color }} />
              <span className="truncate">{squad.name}</span>
            </span>
          );
        },
      },
      {
        id: "priority",
        header: "Priority",
        meta: { label: "Priority", width: "7rem" },
        cell: ({ row }) => <Badge variant="outline">{TASK_PRIORITY_LABELS[row.original.task.priority]}</Badge>,
      },
      {
        id: "status",
        header: "Status",
        meta: { label: "Status", width: "7rem" },
        cell: ({ row }) => <Badge variant="secondary">{TASK_STATUS_LABELS[row.original.task.status]}</Badge>,
      },
      {
        id: "due",
        header: "Due",
        meta: { label: "Due", width: "8rem", cellClassName: "text-muted-foreground" },
        cell: ({ row }) => {
          const { dueDate } = row.original.task;
          if (!dueDate) return "—";
          return (
            <span className="flex items-center gap-1">
              <CalendarDays className="size-3 shrink-0" />
              {formatDueDate(dueDate)}
            </span>
          );
        },
      },
      {
        id: "points",
        header: "Points",
        meta: { label: "Points", width: "5rem", cellClassName: "text-muted-foreground" },
        cell: ({ row }) => row.original.task.storyPoints ?? "—",
      },
      {
        id: "links",
        header: "Links",
        meta: { label: "Links", width: "6rem" },
        cell: ({ row }) => <TaskLinksBadge count={row.original.task.links.length} />,
      },
    ],
    // Empty on purpose: every cell reads `openPanel` through a ref, and nothing
    // else here closes over a changing value, so the definitions stay
    // referentially stable for the lifetime of the view and cells update in
    // place rather than remounting.
    [],
  );

  // The "nothing at all" case stays an early return rather than the grid's
  // `emptyState`, which would nest a message inside the grid's own chrome.
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-8 text-center">No tasks match the current filters.</p>;
  }

  return (
    // Panel chrome lives on the grid root, not on a scrolling wrapper: the
    // scroll viewport is the grid's own `table-container`, so the border stays
    // put while rows and the sticky header move inside it.
    <DataGrid<TaskGridRow>
      gridId="task-list"
      columns={columns}
      rows={rows}
      getRowId={(row) => row.rowKey}
      caption="Tasks"
      height="fill"
      pagination={false}
      toolbar={false}
      className="overflow-hidden rounded-xl border border-border bg-surface-panel"
    />
  );
}
