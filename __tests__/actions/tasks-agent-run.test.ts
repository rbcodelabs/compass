import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The task server actions start a cloud agent's run after a PERSON assigns it (phase 4). The write is already saved when
 * the trigger is consulted, so a trigger that refuses can never undo or fail the assignment.
 */
const { mockAuth, mockGetWorkspace, trigger, prisma } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockGetWorkspace: vi.fn(),
  trigger: vi.fn(),
  prisma: {
    workspaceMember: { findFirst: vi.fn() },
    opportunity: { findFirst: vi.fn() },
    task: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock("@/lib/links/legacy-mirror", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/links/legacy-mirror")>()), mirrorTaskReference: vi.fn(), unmirrorTaskReference: vi.fn() }))
vi.mock("@/auth", () => ({ auth: mockAuth }))
vi.mock("@/lib/workspace", () => ({ getWorkspace: mockGetWorkspace }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/agent-task-trigger", () => ({ startRunForAssignedTask: trigger }))
vi.mock("@/lib/work-item-sequence", async () => (await import("../helpers/work-item-sequence-mock")).workItemSequenceMock())
// assignmentUpdate has its own tests; here it just yields the assignee columns the caller asked for.
vi.mock("@/lib/task-assignment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/task-assignment")>()),
  assignmentUpdate: vi.fn(async (_ws: string, input: { assignee?: { type: string; id: string } | null }) =>
    input.assignee === undefined ? {} : input.assignee === null ? { assigneeUserId: null, assigneeAgentId: null } : input.assignee.type === "AGENT" ? { assigneeUserId: null, assigneeAgentId: input.assignee.id } : { assigneeUserId: input.assignee.id, assigneeAgentId: null }),
  resolveTaskAssignees: vi.fn(async (_ws: string, tasks: object[]) => tasks.map((task) => ({ ...task, assignee: null }))),
}))

import { addLinkedTask, addTask, updateTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions"

const AGENT = { type: "AGENT" as const, id: "agent-1" }
const started = { status: "started", agentName: "Triage", runId: "r1", conversationId: "c1", conversationUrl: "/o/w/agent?c=c1" }

beforeEach(() => {
  vi.clearAllMocks()
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma))
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockGetWorkspace.mockResolvedValue({ id: "ws-1" })
  prisma.workspaceMember.findFirst.mockResolvedValue({ id: "membership" })
  prisma.opportunity.findFirst.mockResolvedValue({ id: "opp-1" })
  prisma.task.findFirst.mockResolvedValue(null)
  prisma.task.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", status: "TODO", assigneeAgentId: null })
  prisma.task.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "task-new", ...data }))
  prisma.task.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "task-1", ...data }))
  trigger.mockResolvedValue({ status: "skipped" })
})

describe("addTask", () => {
  it("starts the agent's run for a new task assigned to a cloud agent, attributed to the signed-in person", async () => {
    trigger.mockResolvedValue(started)
    const result = await addTask("ws-1", { title: "Triage this", assignee: AGENT }, "/p")
    expect(trigger).toHaveBeenCalledWith({ taskId: "task-new", actingUserId: "user-1" })
    expect(result.agentRun).toEqual(started)
  })

  it("does not consult the trigger for a person or no assignee", async () => {
    await addTask("ws-1", { title: "Mine", assignee: { type: "USER", id: "user-1" } }, "/p")
    await addTask("ws-1", { title: "Nobody" }, "/p")
    expect(trigger).not.toHaveBeenCalled()
  })

  it("still saves the task and reports the refusal when the run cannot start", async () => {
    trigger.mockResolvedValue({ status: "refused", code: "AGENT_CAP_REACHED", message: "no run started" })
    const result = await addTask("ws-1", { title: "Triage this", assignee: AGENT }, "/p")
    expect(prisma.task.create).toHaveBeenCalled()
    expect(result.agentRun).toMatchObject({ status: "refused", code: "AGENT_CAP_REACHED" })
  })

  it("leaves agentRun off the result when the trigger skipped", async () => {
    const result = await addTask("ws-1", { title: "Triage this", assignee: AGENT }, "/p")
    expect(result).not.toHaveProperty("agentRun")
  })

  it("starts nothing for someone who is not a member of the workspace", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null)
    await expect(addTask("ws-1", { title: "x", assignee: AGENT }, "/p")).rejects.toThrow("Not found")
    expect(trigger).not.toHaveBeenCalled()
  })
})

describe("updateTask", () => {
  it("passes the previous agent assignee so re-saving the same assignee is a no-op downstream", async () => {
    prisma.task.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", status: "TODO", assigneeAgentId: "agent-0" })
    trigger.mockResolvedValue(started)
    const result = await updateTask("task-1", { assignee: AGENT }, "/p")
    expect(trigger).toHaveBeenCalledWith({ taskId: "task-1", actingUserId: "user-1", previousAssigneeAgentId: "agent-0" })
    expect(result.agentRun).toEqual(started)
  })

  it("does not consult the trigger when the assignee is unchanged, or when the edit is not an assignment", async () => {
    prisma.task.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", status: "TODO", assigneeAgentId: "agent-1" })
    await updateTask("task-1", { assignee: AGENT }, "/p")
    prisma.task.findUnique.mockResolvedValue({ id: "task-1", workspaceId: "ws-1", status: "TODO", assigneeAgentId: null })
    await updateTask("task-1", { title: "Renamed" }, "/p")
    await updateTask("task-1", { assignee: null }, "/p")
    expect(trigger).not.toHaveBeenCalled()
  })

  it("is refused for a non-member before anything is written or started", async () => {
    prisma.workspaceMember.findFirst.mockResolvedValue(null)
    await expect(updateTask("task-1", { assignee: AGENT }, "/p")).rejects.toThrow("Not found")
    expect(prisma.task.update).not.toHaveBeenCalled()
    expect(trigger).not.toHaveBeenCalled()
  })
})

describe("addLinkedTask", () => {
  it("starts the run for a linked task assigned to an agent", async () => {
    trigger.mockResolvedValue(started)
    const result = await addLinkedTask("acme", "product", "OPPORTUNITY", "opp-1", { title: "Investigate", assignee: AGENT }, "/p")
    expect(trigger).toHaveBeenCalledWith({ taskId: "task-new", actingUserId: "user-1" })
    expect(result.agentRun).toEqual(started)
  })

  it("does nothing extra for an unassigned linked task", async () => {
    await addLinkedTask("acme", "product", "OPPORTUNITY", "opp-1", { title: "Investigate" }, "/p")
    expect(trigger).not.toHaveBeenCalled()
  })
})
