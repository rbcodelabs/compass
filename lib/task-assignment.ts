import getPrisma from "@/lib/db";
import { UNASSIGNED_ASSIGNEE_FILTER } from "@/lib/task-assignee-display";
import type { TaskLinkedType } from "@/lib/types";

export type TaskAssignee = { type: "USER" | "AGENT"; id: string } | null;
export type ResolvedTaskAssignee = NonNullable<TaskAssignee> & { displayName: string; available: boolean; ownerName?: string };
export type AssignmentInput = { assignee?: TaskAssignee; assigneeUserId?: string | null };

/** Both columns are always replaced in the same write, including legacy callers. */
export async function assignmentUpdate(workspaceId: string, input: AssignmentInput) {
  if (input.assignee !== undefined && input.assigneeUserId !== undefined) throw new Error("Cannot supply both assignee and assigneeUserId");
  const assignee = input.assignee !== undefined ? input.assignee : input.assigneeUserId === undefined ? undefined : input.assigneeUserId === null ? null : { type: "USER" as const, id: input.assigneeUserId };
  if (assignee === undefined) return {};
  if (assignee === null) return { assigneeUserId: null, assigneeAgentId: null };
  if (!assignee.id || !["USER", "AGENT"].includes(assignee.type)) throw new Error("Invalid assignee");
  const prisma = getPrisma();
  if (assignee.type === "USER") {
    const member = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId: assignee.id }, select: { id: true } });
    if (!member) throw new Error("Assignee is not in this workspace");
    return { assigneeUserId: assignee.id, assigneeAgentId: null };
  }
  if (process.env.COMPASS_AGENTS_ENABLED !== "1") throw new Error("Agent assignments are not enabled");
  const agent = await prisma.agent.findUnique({ where: { id: assignee.id } });
  if (!agent || agent.status !== "ACTIVE") throw new Error("Assignee agent is not active");
  const [grant, member] = await Promise.all([
    prisma.agentWorkspaceGrant.findFirst({ where: { agentId: agent.id, workspaceId, revokedAt: null }, select: { id: true } }),
    prisma.workspaceMember.findFirst({ where: { workspaceId, userId: agent.ownerUserId }, select: { id: true } }),
  ]);
  if (!grant || !member) throw new Error("Agent is not enabled in this workspace");
  return { assigneeUserId: null, assigneeAgentId: assignee.id };
}

export function parseAssigneeFilter(value?: string | null) {
  if (!value) return {};
  // "Unassigned" has to mean the rendered assignee slot is empty, which
  // includes ownerName: the display logic falls back to that freeform string,
  // so a task with ownerName set is owned by somebody even with no user id.
  if (value === UNASSIGNED_ASSIGNEE_FILTER) {
    return { assigneeUserId: null, assigneeAgentId: null, OR: [{ ownerName: null }, { ownerName: "" }] };
  }
  if (value.startsWith("agent:")) return { assigneeAgentId: value.slice(6) };
  return { assigneeUserId: value.startsWith("user:") ? value.slice(5) : value };
}

type AssignedRow = { assigneeUserId?: string | null; assigneeAgentId?: string | null };

/** Batch resolution retains historical assignments without making them selectable. */
export async function resolveTaskAssignees<T extends AssignedRow>(workspaceId: string, tasks: T[]): Promise<Array<T & { assignee: ResolvedTaskAssignee | null }>> {
  const userIds = [...new Set(tasks.flatMap(t => t.assigneeUserId ? [t.assigneeUserId] : []))];
  const agentIds = [...new Set(tasks.flatMap(t => t.assigneeAgentId ? [t.assigneeAgentId] : []))];
  if (!userIds.length && !agentIds.length) return tasks.map(task => ({ ...task, assignee: null }));
  const prisma = getPrisma();
  const agents = agentIds.length ? await prisma.agent.findMany({ where: { id: { in: agentIds } } }) : [];
  const memberIds = [...new Set([...userIds, ...agents.map(agent => agent.ownerUserId)])];
  const [members, grants] = await Promise.all([
    memberIds.length ? prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: memberIds } }, include: { user: { select: { name: true, email: true } } } }) : [],
    agentIds.length ? prisma.agentWorkspaceGrant.findMany({ where: { workspaceId, agentId: { in: agentIds }, revokedAt: null } }) : [],
  ]);
  return tasks.map(task => {
    let assignee: ResolvedTaskAssignee | null = null;
    if (task.assigneeAgentId) {
      const agent = agents.find(a => a.id === task.assigneeAgentId);
      const member = members.find(m => m.userId === agent?.ownerUserId);
      assignee = { type: "AGENT", id: task.assigneeAgentId, displayName: agent?.name ?? "Unavailable agent", available: !!agent && agent.status === "ACTIVE" && !!member && grants.some(g => g.agentId === agent.id) };
    } else if (task.assigneeUserId) {
      const member = members.find(m => m.userId === task.assigneeUserId);
      assignee = { type: "USER", id: task.assigneeUserId, displayName: member?.user.name || member?.user.email || "Unavailable person", available: !!member };
    }
    return { ...task, assignee };
  });
}

export async function eligibleTaskAssignees(workspaceId: string): Promise<ResolvedTaskAssignee[]> {
  const prisma = getPrisma();
  const members = await prisma.workspaceMember.findMany({ where: { workspaceId }, include: { user: { select: { name: true, email: true } } }, orderBy: { userId: "asc" } });
  const people: ResolvedTaskAssignee[] = members.map(m => ({ type: "USER", id: m.userId, displayName: m.user.name || m.user.email, available: true }));
  if (process.env.COMPASS_AGENTS_ENABLED !== "1") return people;
  const grants = await prisma.agentWorkspaceGrant.findMany({ where: { workspaceId, revokedAt: null } });
  if (!grants.length) return people;
  const agents = await prisma.agent.findMany({ where: { id: { in: grants.map(g => g.agentId) }, ownerUserId: { in: members.map(m => m.userId) }, status: "ACTIVE" }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  return [...people, ...agents.map(agent => ({ type: "AGENT" as const, id: agent.id, displayName: agent.name, available: true, ownerName: members.find(m => m.userId === agent.ownerUserId)?.user.name || members.find(m => m.userId === agent.ownerUserId)?.user.email }))];
}

export async function validateTaskReferences(workspaceId: string, input: { squadId?: string | null; parentTaskId?: string | null }) {
  const prisma = getPrisma();
  if (input.squadId && !await prisma.squad.findFirst({ where: { id: input.squadId, workspaceId }, select: { id: true } })) throw new Error("Squad belongs to a different workspace or does not exist");
  if (input.parentTaskId && !await prisma.task.findFirst({ where: { id: input.parentTaskId, workspaceId }, select: { id: true } })) throw new Error("Parent task belongs to a different workspace or does not exist");
}

export async function validateTaskLink(workspaceId: string, linkedType: TaskLinkedType, linkedId: string) {
  const prisma = getPrisma();
  const where = { id: linkedId, workspaceId };
  const target = await (linkedType === "OPPORTUNITY" ? prisma.opportunity.findFirst({ where })
    : linkedType === "SOLUTION" ? prisma.solution.findFirst({ where: { id: linkedId, opportunity: { workspaceId } } })
    : linkedType === "ROADMAP_ITEM" ? prisma.roadmapItem.findFirst({ where })
    : linkedType === "OBJECTIVE" ? prisma.objective.findFirst({ where: { id: linkedId, cycle: { workspaceId } } })
    : linkedType === "KEY_RESULT" ? prisma.keyResult.findFirst({ where: { id: linkedId, objective: { cycle: { workspaceId } } } })
    : linkedType === "DOC" ? prisma.doc.findFirst({ where })
    : linkedType === "EXPERIMENT" ? prisma.experiment.findFirst({ where })
    : linkedType === "DECISION" ? prisma.reviewRequest.findFirst({ where })
    : prisma.feedbackItem.findFirst({ where }));
  if (!target) throw new Error("Linked object belongs to a different workspace or does not exist");
  return target;
}

export function taskLinkScope(workspaceId: string, linkedType: string): Record<string, unknown> {
  if (linkedType === "SOLUTION") return { opportunity: { workspaceId } };
  if (linkedType === "OBJECTIVE") return { cycle: { workspaceId } };
  if (linkedType === "KEY_RESULT") return { objective: { cycle: { workspaceId } } };
  return { workspaceId };
}
