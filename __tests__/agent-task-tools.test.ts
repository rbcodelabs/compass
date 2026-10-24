import { describe, it, expect, vi, beforeEach } from "vitest"
import { runWithMcpActor, type McpActor } from "@/lib/mcp-authz"
import { ok } from "@/lib/mcp-output"

const prisma = vi.hoisted(() => ({
  agentRun: { findFirst: vi.fn() },
  task: { findFirst: vi.fn(), findMany: vi.fn() },
}))
const handlers = vi.hoisted(() => ({ createTask: vi.fn(), updateTask: vi.fn(), moveTaskStatus: vi.fn() }))
const links = vi.hoisted(() => ({ createTaskLink: vi.fn() }))

vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("@/lib/task-tool-handlers", () => handlers)
vi.mock("@/lib/task-link-writes", () => links)

import { agentTaskCreate, agentTaskGet, agentTaskList, agentTaskUpdate, toAgentStatus } from "@/lib/agent-task-tools"

const TASK = "11111111-1111-4111-8111-111111111111"
const CONV = "22222222-2222-4222-8222-222222222222"
const WS = "33333333-3333-4333-8333-333333333333"
const turn: McpActor = { userId: "u1", purpose: "AGENT_TURN", credentialId: "key1" }
const as = <T,>(actor: McpActor, fn: () => Promise<T>) => runWithMcpActor(actor, fn)

beforeEach(() => {
  vi.clearAllMocks()
  prisma.agentRun.findFirst.mockResolvedValue({ conversationId: CONV, workspaceId: WS })
})

describe("agent task tools", () => {
  it("maps Compass statuses onto the agent's three", () => {
    expect(["DONE", "IN_PROGRESS", "TODO", "BLOCKED", "BACKLOG"].map(toAgentStatus)).toEqual(["completed", "in_progress", "pending", "pending", "pending"])
  })

  it("refuses outside an agent turn, and when the key has no live run", async () => {
    const user = await as({ userId: "u1", purpose: "USER" }, () => agentTaskList())
    expect(user.structuredContent.ok).toBe(false)
    expect(prisma.agentRun.findFirst).not.toHaveBeenCalled()
    prisma.agentRun.findFirst.mockResolvedValue(null)
    expect((await as(turn, () => agentTaskList())).structuredContent.ok).toBe(false)
  })

  it("creates an AGENT-sourced task and links it to the conversation resolved from the key", async () => {
    handlers.createTask.mockResolvedValue(ok("created", { id: TASK }))
    const res = await as(turn, () => agentTaskCreate({ subject: "Write tests", description: "d" }))
    expect(prisma.agentRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ apiKeyId: "key1" }) }))
    expect(handlers.createTask).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, title: "Write tests", rowSource: "AGENT" }))
    expect(links.createTaskLink).toHaveBeenCalledWith(prisma, { taskId: TASK, linkedType: "AGENT_CONVERSATION", linkedId: CONV, workspaceId: WS })
    expect(res.structuredContent.data).toMatchObject({ id: TASK, status: "pending" })
  })

  it("only touches tasks linked to this conversation", async () => {
    prisma.task.findFirst.mockResolvedValue(null)
    const res = await as(turn, () => agentTaskUpdate({ taskId: TASK, status: "completed" }))
    expect(res.structuredContent.ok).toBe(false)
    expect(prisma.task.findFirst.mock.calls[0][0].where.links.some).toEqual({ linkedType: "AGENT_CONVERSATION", linkedId: CONV })
    expect(handlers.moveTaskStatus).not.toHaveBeenCalled()
    expect((await as(turn, () => agentTaskGet({ taskId: "not-a-uuid" }))).structuredContent.ok).toBe(false)
  })

  it("maps status updates, and cancels rather than deletes", async () => {
    prisma.task.findFirst.mockResolvedValue({ id: TASK, title: "T", description: null, status: "DONE" })
    handlers.moveTaskStatus.mockResolvedValue(ok("moved"))
    await as(turn, () => agentTaskUpdate({ taskId: TASK, status: "in_progress" }))
    expect(handlers.moveTaskStatus).toHaveBeenLastCalledWith({ taskId: TASK, status: "IN_PROGRESS" })
    await as(turn, () => agentTaskUpdate({ taskId: TASK, status: "deleted" }))
    expect(handlers.moveTaskStatus).toHaveBeenLastCalledWith({ taskId: TASK, status: "CANCELLED" })
  })

  it("lists this conversation's non-cancelled tasks", async () => {
    prisma.task.findMany.mockResolvedValue([{ id: TASK, title: "A", description: "x", status: "IN_PROGRESS" }])
    const res = await as(turn, () => agentTaskList())
    expect(prisma.task.findMany.mock.calls[0][0].where.status).toEqual({ not: "CANCELLED" })
    expect(res.structuredContent.data).toMatchObject({ count: 1, items: [{ subject: "A", status: "in_progress" }] })
  })
})
