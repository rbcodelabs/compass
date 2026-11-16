import type { TaskCardData } from "@/components/tasks/task-card";
import { isTaskOriginLink } from "@/lib/task-links-read";
import type { TaskLinkRecordType, TaskPriority, TaskStatus } from "@/lib/types";

type TaskCardRow = Omit<TaskCardData, "status" | "priority" | "squad" | "dueDate" | "subtaskCount" | "links"> & {
  status: string;
  priority: string;
  dueDate: Date | null;
};
type SquadRow = { id: string; name: string; color: string };
type TaskLinkRow = { id: string; taskId: string; linkedType: string; linkedId: string; isOrigin?: boolean };
type SubtaskCountRow = { parentTaskId: string | null; _count: { _all: number } };

export function buildTaskCards(input: {
  tasks: TaskCardRow[];
  squads: SquadRow[];
  links: TaskLinkRow[];
  subtaskCounts: SubtaskCountRow[];
  linkedTitles: Map<string, string>;
  linkedHrefs?: Map<string, string | null>;
}): TaskCardData[] {
  const squadById = new Map(input.squads.map((squad) => [squad.id, squad]));
  const linksByTaskId = new Map<string, TaskLinkRow[]>();
  for (const link of input.links) {
    const taskLinks = linksByTaskId.get(link.taskId) ?? [];
    taskLinks.push(link);
    linksByTaskId.set(link.taskId, taskLinks);
  }
  const subtaskCountByParentId = new Map(
    input.subtaskCounts.flatMap((row) => row.parentTaskId ? [[row.parentTaskId, row._count._all] as const] : [])
  );

  return input.tasks.map((task) => ({
    ...task,
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
    squad: task.squadId ? squadById.get(task.squadId) ?? null : null,
    dueDate: task.dueDate?.toISOString() ?? null,
    subtaskCount: subtaskCountByParentId.get(task.id) ?? 0,
    links: (linksByTaskId.get(task.id) ?? []).map((link) => {
      const key = `${link.linkedType}:${link.linkedId}`;
      return {
        id: link.id,
        linkedType: link.linkedType as TaskLinkRecordType,
        linkedId: link.linkedId,
        linkedTitle: input.linkedTitles.get(key) ?? "(deleted)",
        isOrigin: link.isOrigin ?? isTaskOriginLink(link.linkedType),
        ...(input.linkedHrefs?.has(key) ? { linkedHref: input.linkedHrefs.get(key) ?? null } : {}),
      };
    }),
  }));
}
