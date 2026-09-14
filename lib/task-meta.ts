import type { TaskPriority, TaskStatus } from "@/lib/types";

/**
 * Single source of truth for how a task's `priority` and `status` are spelled
 * in the UI, in the shape of `lib/feedback-meta.ts`.
 *
 * Priority previously had no map at all — every surface rendered the raw enum
 * (`URGENT`, `MEDIUM`) except the filter menu, which title-cased it inline.
 * Status had one, but it lived in `components/tasks/task-column.tsx`, whose
 * import graph reaches the tasks server actions; pulling that into a leaf view
 * just to read a label drags `next-auth` in with it. `STATUS_CONFIG` there now
 * builds its labels from `TASK_STATUS_LABELS`, so there is still exactly one
 * spelling of each status — this module is just the part that is safe to import
 * from anywhere. Pure data, no React import.
 */
export const TASK_PRIORITIES = ["URGENT", "HIGH", "MEDIUM", "LOW"] as const;

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  BACKLOG: "Backlog",
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  BLOCKED: "Blocked",
  IN_REVIEW: "In Review",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

function isTaskPriority(value: unknown): value is TaskPriority {
  return (
    typeof value === "string" &&
    (TASK_PRIORITIES as readonly string[]).includes(value)
  );
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && value in TASK_STATUS_LABELS;
}

/** Label for a priority, falling back to the raw value for forward compatibility. */
export function taskPriorityLabel(value: string): string {
  return isTaskPriority(value) ? TASK_PRIORITY_LABELS[value] : value;
}

/** Label for a status, falling back to the raw value for forward compatibility. */
export function taskStatusLabel(value: string): string {
  return isTaskStatus(value) ? TASK_STATUS_LABELS[value] : value;
}
