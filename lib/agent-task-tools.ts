/**
 * The agent's own task list, exposed under the Claude Code tool names the model already knows
 * (TaskCreate / TaskUpdate / TaskList / TaskGet) and backed by Compass tasks.
 *
 * Every task is stored as a normal Task row with source = "AGENT" and a TaskLink of linkedType
 * AGENT_CONVERSATION, so the task screen can show it and the chat can read the plan back from the server.
 * The conversation is never a tool argument: it is resolved from the calling turn key's live AgentRun
 * (AgentRun.apiKeyId), so a model cannot read or touch another conversation's tasks.
 */
import getPrisma from "@/lib/db"
import { getMcpActor } from "@/lib/mcp-authz"
import { ok, fail } from "@/lib/mcp-output"
import { createTaskLink } from "@/lib/task-link-writes"
import { createTask, moveTaskStatus, updateTask } from "@/lib/task-tool-handlers"
import type { TaskStatus } from "@/lib/types"

export type AgentTaskStatus = "pending" | "in_progress" | "completed" | "deleted"

const TO_COMPASS: Record<Exclude<AgentTaskStatus, "deleted">, TaskStatus> = { pending: "TODO", in_progress: "IN_PROGRESS", completed: "DONE" }

/** Compass has more statuses than the agent's three; anything not started or finished reads as pending. */
export function toAgentStatus(status: string): Exclude<AgentTaskStatus, "deleted"> {
  return status === "DONE" ? "completed" : status === "IN_PROGRESS" ? "in_progress" : "pending"
}

type Conversation = { conversationId: string; workspaceId: string }

async function currentConversation(): Promise<Conversation | null> {
  const actor = getMcpActor()
  if (actor.purpose !== "AGENT_TURN" || !actor.credentialId) return null
  const run = await getPrisma().agentRun.findFirst({
    where: { apiKeyId: actor.credentialId, status: { in: ["QUEUED", "RUNNING"] } },
    select: { conversationId: true, workspaceId: true },
  })
  return run ? { conversationId: run.conversationId, workspaceId: run.workspaceId } : null
}

const NOT_IN_CONVERSATION = "Task tools are only available inside an agent conversation."

/** The task, only if it is linked to this conversation. A foreign or unknown id reads as not found. */
async function conversationTask(ctx: Conversation, taskId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null
  return getPrisma().task.findFirst({
    where: { id: taskId, workspaceId: ctx.workspaceId, links: { some: { linkedType: "AGENT_CONVERSATION", linkedId: ctx.conversationId } } },
    select: { id: true, title: true, description: true, status: true },
  })
}

const view = (t: { id: string; title: string; description: string | null; status: string }) => ({
  id: t.id, subject: t.title, description: t.description ?? "", status: toAgentStatus(t.status),
})

export async function agentTaskCreate({ subject, description }: { subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> }) {
  const ctx = await currentConversation()
  if (!ctx) return fail(NOT_IN_CONVERSATION)
  const created = await createTask({ workspaceId: ctx.workspaceId, title: subject, description, status: "TODO", rowSource: "AGENT" })
  const task = (created.structuredContent.data as { id?: string } | null)
  if (!created.structuredContent.ok || !task?.id) return created
  await createTaskLink(getPrisma(), { taskId: task.id, linkedType: "AGENT_CONVERSATION", linkedId: ctx.conversationId, workspaceId: ctx.workspaceId })
  return ok(`Task created: ${subject}\nID: ${task.id}`, { id: task.id, subject, description, status: "pending" })
}

export async function agentTaskUpdate({ taskId, subject, description, status }: { taskId: string; subject?: string; description?: string; activeForm?: string; status?: AgentTaskStatus }) {
  const ctx = await currentConversation()
  if (!ctx) return fail(NOT_IN_CONVERSATION)
  const existing = await conversationTask(ctx, taskId)
  if (!existing) return fail(`Task "${taskId}" not found in this conversation.`)
  if (subject !== undefined || description !== undefined) {
    const res = await updateTask({ taskId, title: subject, description })
    if (!res.structuredContent.ok) return res
  }
  if (status !== undefined) {
    // "deleted" cancels rather than hard-deleting: the row stays auditable and drops out of TaskList.
    const res = await moveTaskStatus({ taskId, status: status === "deleted" ? "CANCELLED" : TO_COMPASS[status] })
    if (!res.structuredContent.ok) return res
  }
  const after = await conversationTask(ctx, taskId)
  return ok(`Task updated: ${after?.title ?? existing.title}\nStatus: ${status === "deleted" ? "deleted" : toAgentStatus(after?.status ?? existing.status)}`, after ? view(after) : { id: taskId, status: "deleted" })
}

export async function agentTaskList() {
  const ctx = await currentConversation()
  if (!ctx) return fail(NOT_IN_CONVERSATION)
  const rows = await getPrisma().task.findMany({
    where: { workspaceId: ctx.workspaceId, status: { not: "CANCELLED" }, links: { some: { linkedType: "AGENT_CONVERSATION", linkedId: ctx.conversationId } } },
    select: { id: true, title: true, description: true, status: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  const items = rows.map(view)
  return ok(items.length ? items.map((t) => `[${t.status}] ${t.subject} — ID: ${t.id}`).join("\n") : "No tasks in this conversation.", { items, count: items.length })
}

export async function agentTaskGet({ taskId }: { taskId: string }) {
  const ctx = await currentConversation()
  if (!ctx) return fail(NOT_IN_CONVERSATION)
  const task = await conversationTask(ctx, taskId)
  if (!task) return fail(`Task "${taskId}" not found in this conversation.`)
  const v = view(task)
  return ok(`${v.subject}\nStatus: ${v.status}\n${v.description}\nID: ${v.id}`.trim(), v)
}
