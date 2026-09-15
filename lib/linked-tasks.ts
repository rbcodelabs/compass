/**
 * Shared "delivery tasks" bundle for every TaskLink-eligible detail surface:
 * the tasks currently linked to this entity, the tasks that could still be
 * linked, and the workspace's members (for the assignee picker). Originally
 * lived only on RoadmapItem (lib/entity-detail.ts's fetchRoadmapItem); pulled
 * out here so every other linkable object type (Opportunity, Solution,
 * Experiment, Objective, Key Result, Doc, Feedback Item) can render the same
 * section via components/tasks/linked-tasks-section.tsx without re-deriving
 * the query. Doc isn't part of the entity-detail.ts dispatch (it has its own
 * full-page editor, not a side panel), so this lives standalone rather than
 * inside entity-detail.ts, and the doc page calls it directly.
 */
import getPrisma from "@/lib/db";
import { resolveTaskAssignees } from "@/lib/task-assignment";
import { normalizeWorkspaceRole } from "@/lib/roles";
import type { TaskLinkedType, TaskPriority, TaskStatus } from "@/lib/types";

const STATUS_PRECEDENCE: Record<string, number> = {
  BLOCKED: 0,
  IN_REVIEW: 1,
  IN_PROGRESS: 2,
  DONE: 3,
  TODO: 4,
  BACKLOG: 5,
};

export async function fetchLinkedTasksBundle(workspaceId: string, linkedType: TaskLinkedType, linkedId: string) {
  const prisma = getPrisma();
  const [deliveryTasksRaw, linkableTasks, members] = await Promise.all([
    prisma.task.findMany({
      where: {
        workspaceId,
        status: { not: "CANCELLED" },
        links: { some: { linkedType, linkedId } },
      },
      select: {
        id: true,
        title: true,
        status: true,
        priority: true,
        assigneeUserId: true,
        assigneeAgentId: true,
        ownerName: true,
        sortOrder: true,
        createdAt: true,
      },
      orderBy: [{ status: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.task.findMany({
      where: {
        workspaceId,
        status: { not: "CANCELLED" },
        links: { none: { linkedType, linkedId } },
      },
      select: { id: true, title: true },
      orderBy: [{ title: "asc" }, { id: "asc" }],
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId },
      select: {
        id: true,
        userId: true,
        role: true,
        user: { select: { email: true, name: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);

  deliveryTasksRaw.sort(
    (a, b) =>
      (STATUS_PRECEDENCE[a.status] ?? 99) - (STATUS_PRECEDENCE[b.status] ?? 99) ||
      a.sortOrder - b.sortOrder ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id)
  );

  // `status`/`priority` are plain VARCHAR columns (see prisma/schema.prisma's
  // note on Task — DSQL app-level enum discipline, not a DB enum), so Prisma
  // infers them as `string`. Narrow here at the read boundary, same as every
  // other Task reader (e.g. lib/task-read-model.ts).
  const deliveryTasksTyped = deliveryTasksRaw.map((task) => ({
    ...task,
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
  }));

  return {
    deliveryTasks: await resolveTaskAssignees(workspaceId, deliveryTasksTyped),
    linkableTasks,
    members: members.map((member) => ({
      id: member.id,
      userId: member.userId,
      // `role` is a plain VARCHAR column that has historically held values
      // outside the WorkspaceRole union (e.g. "OWNER", "owner") — coerce
      // through the shared normalizer rather than trusting the raw string.
      // See lib/roles.ts for the production lockout this guards against.
      role: normalizeWorkspaceRole(member.role),
      email: member.user.email,
      name: member.user.name,
    })),
  };
}
