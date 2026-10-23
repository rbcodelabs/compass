import getPrisma from "@/lib/db";
import { agentsEnabledInWorkspace } from "@/lib/agent-access";
import { moduleDisabledMessage } from "@/lib/modules/registry";
import { agentEligibleInWorkspace, agentKind, type AgentRecord, agentOwner, findAgentById, findAgentsByIds, withAgentColumns } from "@/lib/agent-ownership";
import { UNASSIGNED_ASSIGNEE_FILTER } from "@/lib/task-assignee-display";
import type { TaskLinkRecordType } from "@/lib/types";

export type TaskAssignee = { type: "USER" | "AGENT"; id: string } | null;
export type ResolvedTaskAssignee = NonNullable<TaskAssignee> & { displayName: string; available: boolean; ownerName?: string; /** Agents only: a CLOUD agent runs when assigned; an EXTERNAL one is only queued. */ agentKind?: "EXTERNAL" | "CLOUD" };
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
  if (!(await agentsEnabledInWorkspace(workspaceId))) throw new Error(moduleDisabledMessage("agents"));
  const agent = await findAgentById(prisma, assignee.id);
  if (!agent || agent.status !== "ACTIVE") throw new Error("Assignee agent is not active");
  const owner = agentOwner(agent);
  const [grant, member] = await Promise.all([
    prisma.agentWorkspaceGrant.findFirst({ where: { agentId: agent.id, workspaceId, revokedAt: null }, select: { id: true } }),
    // Only a USER-owned agent needs its owner to still be a member; a WORKSPACE-owned one has no owner user.
    owner?.type === "USER" ? prisma.workspaceMember.findFirst({ where: { workspaceId, userId: owner.userId }, select: { id: true } }) : null,
  ]);
  if (!agentEligibleInWorkspace(agent, { workspaceId, hasLiveGrant: !!grant, memberUserIds: new Set(member && owner?.type === "USER" ? [owner.userId] : []) })) throw new Error("Agent is not enabled in this workspace");
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
  const agents = await findAgentsByIds(prisma, agentIds);
  const memberIds = [...new Set([...userIds, ...agents.flatMap(agent => { const owner = agentOwner(agent); return owner?.type === "USER" ? [owner.userId] : []; })])];
  const [members, grants] = await Promise.all([
    memberIds.length ? prisma.workspaceMember.findMany({ where: { workspaceId, userId: { in: memberIds } }, include: { user: { select: { name: true, email: true } } } }) : [],
    agentIds.length ? prisma.agentWorkspaceGrant.findMany({ where: { workspaceId, agentId: { in: agentIds }, revokedAt: null } }) : [],
  ]);
  return tasks.map(task => {
    let assignee: ResolvedTaskAssignee | null = null;
    if (task.assigneeAgentId) {
      const agent = agents.find(a => a.id === task.assigneeAgentId);
      const memberUserIds = new Set(members.map(m => m.userId));
      assignee = { type: "AGENT", id: task.assigneeAgentId, displayName: agent?.name ?? "Unavailable agent", ...(agent ? { agentKind: agentKind(agent) } : {}), available: !!agent && agentEligibleInWorkspace(agent, { workspaceId, hasLiveGrant: grants.some(g => g.agentId === agent.id), memberUserIds }) };
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
  if (!(await agentsEnabledInWorkspace(workspaceId))) return people;
  const grants = await prisma.agentWorkspaceGrant.findMany({ where: { workspaceId, revokedAt: null } });
  if (!grants.length) return people;
  const granted = await withAgentColumns(({ select }) => prisma.agent.findMany({ where: { id: { in: grants.map(g => g.agentId) }, status: "ACTIVE" }, select, orderBy: [{ name: "asc" }, { id: "asc" }] }));
  const memberUserIds = new Set(members.map(m => m.userId));
  // A grant is necessary for everyone; a USER-owned agent additionally needs its owner to still be a member.
  const agents = (granted as AgentRecord[]).filter(agent => agentEligibleInWorkspace(agent, { workspaceId, hasLiveGrant: true, memberUserIds }));
  return [...people, ...agents.map(agent => {
    const owner = agentOwner(agent);
    const ownerMember = owner?.type === "USER" ? members.find(m => m.userId === owner.userId) : undefined;
    return { type: "AGENT" as const, id: agent.id, displayName: agent.name, agentKind: agentKind(agent), available: true, ownerName: ownerMember?.user.name || ownerMember?.user.email };
  })];
}

export async function validateTaskReferences(workspaceId: string, input: { squadId?: string | null; parentTaskId?: string | null }) {
  const prisma = getPrisma();
  if (input.squadId && !await prisma.squad.findFirst({ where: { id: input.squadId, workspaceId }, select: { id: true } })) throw new Error("Squad belongs to a different workspace or does not exist");
  if (input.parentTaskId && !await prisma.task.findFirst({ where: { id: input.parentTaskId, workspaceId }, select: { id: true } })) throw new Error("Parent task belongs to a different workspace or does not exist");
}

export async function validateTaskLink(workspaceId: string, linkedType: TaskLinkRecordType, linkedId: string) {
  const prisma = getPrisma();
  const where = { id: linkedId, workspaceId };
  const target = await (linkedType === "OPPORTUNITY" ? prisma.opportunity.findFirst({ where })
    : linkedType === "SOLUTION" ? prisma.solution.findFirst({ where: { id: linkedId, workspaceId } })
    : linkedType === "ROADMAP_ITEM" ? prisma.roadmapItem.findFirst({ where })
    : linkedType === "OBJECTIVE" ? prisma.objective.findFirst({ where: { id: linkedId, workspaceId } })
    : linkedType === "KEY_RESULT" ? prisma.keyResult.findFirst({ where: { id: linkedId, objective: { workspaceId } } })
    : linkedType === "DOC" ? prisma.doc.findFirst({ where, select: { id: true } })
    : linkedType === "EXPERIMENT" ? prisma.experiment.findFirst({ where })
    : linkedType === "DECISION" ? prisma.reviewRequest.findFirst({ where })
    // Any comment in the workspace is linkable (Doc comments and Discussion comments); the Comment row carries its own workspaceId.
    : linkedType === "COMMENT" ? prisma.comment.findFirst({ where: { id: linkedId, workspaceId }, select: { id: true } })
    : prisma.feedbackItem.findFirst({ where }));
  if (!target) throw new Error("Linked object belongs to a different workspace or does not exist");
  return target;
}

export function taskLinkScope(workspaceId: string, linkedType: string): Record<string, unknown> {
  if (linkedType === "KEY_RESULT") return { objective: { workspaceId } };
  // Solution and Objective carry their own workspaceId (migration 068).
  return { workspaceId };
}
