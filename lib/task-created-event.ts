import type { TaskCardData } from "@/components/tasks/task-card";

/**
 * The header's "New task" dialog lives outside `TaskBoard`, which seeds its
 * column state once (so optimistic drag-and-drop survives revalidation) and is
 * deliberately not keyed on its rows. The dialog hands the new card to the
 * board over this window event instead.
 */
export const TASK_CREATED_EVENT = "compass:task-created";

export function dispatchTaskCreated(task: TaskCardData) {
  window.dispatchEvent(new CustomEvent<TaskCardData>(TASK_CREATED_EVENT, { detail: task }));
}
