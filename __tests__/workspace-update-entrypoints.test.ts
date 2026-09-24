import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ record: vi.fn(), member: vi.fn(), create: vi.fn(), auth: vi.fn() }))
const db = {
  workspaceMember: { findFirst: mocks.member },
  workspace: { findUnique: vi.fn(async () => ({ id: "w", slug: "workspace", organization: { slug: "org" } })) },
  task: { create: mocks.create, findFirst: vi.fn(async () => null) },
}
vi.mock("@/lib/db", () => ({ default: () => db }))
vi.mock("@/auth", () => ({ auth: mocks.auth }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/task-assignment", () => ({ assignmentUpdate: async () => ({}), validateTaskReferences: async () => {}, resolveTaskAssignees: async (_workspace: string, tasks: unknown[]) => tasks }))
vi.mock("@/lib/workspace-updates-capture", () => ({ withWorkspaceUpdates: (tx: unknown, fn: (tx: unknown, enabled: boolean) => unknown) => fn(tx, true), recordWorkspaceUpdate: mocks.record }))
import { addTask } from "@/app/[orgSlug]/[workspaceSlug]/tasks/actions"
import { createTask } from "@/lib/task-tool-handlers"
import { runWithMcpActor } from "@/lib/mcp-authz"
beforeEach(() => {
  vi.clearAllMocks()
  mocks.member.mockResolvedValue({ id: "membership" })
  mocks.auth.mockResolvedValue({ user: { id: "human" } })
  mocks.create.mockResolvedValue({ id: "t", workspaceId: "w", status: "TODO", title: "Work", priority: "MEDIUM" })
})
it("captures equivalent UI and MCP task creation with their own identities", async () => {
  await addTask("w", { title: "Work" }, "/tasks")
  await runWithMcpActor({ purpose: "AGENT", agentId: "agent", userId: "owner" }, () => createTask({ workspaceId: "w", title: "Work" }))
  expect(mocks.record.mock.calls.map(call => call[1])).toEqual([
    expect.objectContaining({ workspaceId: "w", entityType: "TASK", entityId: "t", kind: "CREATED", actorType: "USER", actorId: "human" }),
    expect.objectContaining({ workspaceId: "w", entityType: "TASK", entityId: "t", kind: "CREATED", actorType: "AGENT", actorId: "agent" }),
  ])
})
it("does not capture or write a task when the UI membership check fails", async () => {
  mocks.member.mockResolvedValue(null)
  await expect(addTask("w", { title: "Work" }, "/tasks")).rejects.toThrow("Not found")
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.record).not.toHaveBeenCalled()
})
