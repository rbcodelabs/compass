/**
 * Unit tests for the Tasks MCP tool handlers (create_task, get_task,
 * list_tasks, update_task, move_task_status, link_task, unlink_task,
 * list_task_links).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------

const mockWorkspace = { findUnique: vi.fn() }
const mockTask = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}
const mockTaskLink = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
}
const mockOpportunity = { findUnique: vi.fn(), findMany: vi.fn() }
const mockSolution = { findUnique: vi.fn(), findMany: vi.fn() }
const mockRoadmapItem = { findUnique: vi.fn(), findMany: vi.fn() }
const mockDoc = { findUnique: vi.fn(), findMany: vi.fn() }

const mockPrisma = {
  workspace: mockWorkspace,
  task: mockTask,
  taskLink: mockTaskLink,
  opportunity: mockOpportunity,
  solution: mockSolution,
  roadmapItem: mockRoadmapItem,
  objective: { findUnique: vi.fn(), findMany: vi.fn() },
  keyResult: { findUnique: vi.fn(), findMany: vi.fn() },
  doc: mockDoc,
  experiment: { findUnique: vi.fn(), findMany: vi.fn() },
  feedbackItem: { findUnique: vi.fn(), findMany: vi.fn() },
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  moveTaskStatus,
  linkTask,
  unlinkTask,
  listTaskLinks,
} from "@/lib/task-tool-handlers"

// ---------------------------------------------------------------------------

const WORKSPACE_ID = "ws-1"
const TASK_ID = "task-1"
const OPP_ID = "opp-1"

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWorkspace.findUnique.mockResolvedValue({ id: WORKSPACE_ID })
  mockTask.findFirst.mockResolvedValue(null)
  mockTask.findUnique.mockResolvedValue({
    id: TASK_ID,
    title: "Ship payments",
    workspaceId: WORKSPACE_ID,
    status: "TODO",
    priority: "MEDIUM",
    description: null,
    parentTaskId: null,
    assigneeUserId: null,
    ownerName: null,
    storyPoints: null,
    dueDate: null,
    iteration: null,
    squadId: null,
    parentTask: null,
    subtasks: [],
    links: [],
  })
  mockTask.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: TASK_ID, title: (data.title as string) ?? "Task", status: data.status ?? "TODO", priority: data.priority ?? "MEDIUM" })
  )
  mockTask.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: TASK_ID, title: "Ship payments", status: data.status ?? "TODO", priority: data.priority ?? "MEDIUM" })
  )
  mockOpportunity.findUnique.mockResolvedValue({ id: OPP_ID, title: "Reduce churn" })
  mockOpportunity.findMany.mockResolvedValue([{ id: OPP_ID, title: "Reduce churn" }])
})

// ─── createTask ───────────────────────────────────────────────────────────────

describe("createTask", () => {
  it("returns a not-found message when the workspace does not exist", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(null)

    const result = await createTask({ workspaceId: "missing-ws", title: "Test" })

    expect(textOf(result)).toContain("not found")
    expect(mockTask.create).not.toHaveBeenCalled()
  })

  it("returns a not-found message for a missing parentTaskId", async () => {
    mockTask.findUnique.mockResolvedValueOnce(null)

    const result = await createTask({ workspaceId: WORKSPACE_ID, title: "Subtask", parentTaskId: "missing-parent" })

    expect(textOf(result)).toContain("not found")
    expect(mockTask.create).not.toHaveBeenCalled()
  })

  it("rejects a parent task from a different workspace", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: "parent-1", workspaceId: "other-ws" })

    const result = await createTask({ workspaceId: WORKSPACE_ID, title: "Subtask", parentTaskId: "parent-1" })

    expect(textOf(result)).toContain("different workspace")
    expect(mockTask.create).not.toHaveBeenCalled()
  })

  it("creates a task with defaults (TODO/MEDIUM) at sortOrder 0", async () => {
    const result = await createTask({ workspaceId: WORKSPACE_ID, title: "  Ship payments  " })

    const data = mockTask.create.mock.calls[0][0].data
    expect(data.title).toBe("Ship payments")
    expect(data.status).toBe("TODO")
    expect(data.priority).toBe("MEDIUM")
    expect(data.sortOrder).toBe(0)

    const text = textOf(result)
    expect(text).toContain(`ID: ${TASK_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("places the task after the last item in its status column", async () => {
    mockTask.findFirst.mockResolvedValueOnce({ sortOrder: 4 })
    await createTask({ workspaceId: WORKSPACE_ID, title: "Task X", status: "IN_PROGRESS" })
    const data = mockTask.create.mock.calls[0][0].data
    expect(data.sortOrder).toBe(5)
  })

  it("passes through optional fields", async () => {
    await createTask({
      workspaceId: WORKSPACE_ID,
      title: "Task Y",
      priority: "HIGH",
      squadId: "squad-1",
      assigneeUserId: "user-1",
      ownerName: "Jane Doe",
      storyPoints: 5,
      dueDate: "2026-08-15",
      iteration: "Sprint 24",
    })
    const data = mockTask.create.mock.calls[0][0].data
    expect(data.priority).toBe("HIGH")
    expect(data.squadId).toBe("squad-1")
    expect(data.assigneeUserId).toBe("user-1")
    expect(data.ownerName).toBe("Jane Doe")
    expect(data.storyPoints).toBe(5)
    expect(data.dueDate).toBeInstanceOf(Date)
    expect(data.iteration).toBe("Sprint 24")
  })

  it("creates a valid subtask under an existing parent in the same workspace", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: "parent-1", workspaceId: WORKSPACE_ID })
    await createTask({ workspaceId: WORKSPACE_ID, title: "Subtask", parentTaskId: "parent-1" })
    const data = mockTask.create.mock.calls[0][0].data
    expect(data.parentTaskId).toBe("parent-1")
  })
})

// ─── getTask ──────────────────────────────────────────────────────────────────

describe("getTask", () => {
  it("returns a not-found message when the task does not exist", async () => {
    mockTask.findUnique.mockResolvedValueOnce(null)

    const result = await getTask({ taskId: "missing-task" })

    expect(textOf(result)).toContain("not found")
  })

  it("returns a bare ID line, not bolded", async () => {
    const result = await getTask({ taskId: TASK_ID })

    const text = textOf(result)
    expect(text).toContain(`ID: ${TASK_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("includes resolved parent, subtasks, and links", async () => {
    mockTask.findUnique.mockResolvedValueOnce({
      id: TASK_ID,
      title: "Ship payments",
      status: "IN_PROGRESS",
      priority: "HIGH",
      description: "Payment flow",
      parentTaskId: "epic-1",
      assigneeUserId: null,
      ownerName: "Jane",
      storyPoints: 3,
      dueDate: null,
      iteration: null,
      squadId: null,
      parentTask: { id: "epic-1", title: "Payments Epic" },
      subtasks: [{ id: "sub-1", title: "Wire up Stripe", status: "TODO" }],
      links: [{ id: "link-1", linkedType: "OPPORTUNITY", linkedId: OPP_ID }],
    })

    const result = await getTask({ taskId: TASK_ID })
    const text = textOf(result)

    expect(text).toContain("Payments Epic")
    expect(text).toContain("Wire up Stripe")
    expect(text).toContain("Reduce churn")
    expect(text).toContain("[OPPORTUNITY]")
  })

  it("shows 'none' for empty subtasks and links", async () => {
    const result = await getTask({ taskId: TASK_ID })
    const text = textOf(result)
    expect(text).toContain("Subtasks: none")
    expect(text).toContain("Links: none")
  })
})

// ─── listTasks ────────────────────────────────────────────────────────────────

describe("listTasks", () => {
  it("returns a not-found message when the workspace does not exist", async () => {
    mockWorkspace.findUnique.mockResolvedValueOnce(null)
    const result = await listTasks({ workspaceId: "missing-ws" })
    expect(textOf(result)).toContain("not found")
  })

  it("returns a message when there are no matching tasks", async () => {
    mockTask.findMany.mockResolvedValueOnce([])
    const result = await listTasks({ workspaceId: WORKSPACE_ID })
    expect(textOf(result)).toContain("No tasks found")
  })

  it("filters by status, priority, squad, and assignee", async () => {
    mockTask.findMany.mockResolvedValueOnce([])
    await listTasks({ workspaceId: WORKSPACE_ID, status: "BLOCKED", priority: "URGENT", squadId: "sq-1", assigneeUserId: "u-1" })
    const where = mockTask.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ workspaceId: WORKSPACE_ID, status: "BLOCKED", priority: "URGENT", squadId: "sq-1", assigneeUserId: "u-1" })
  })

  it("filters changed or stale tasks using factual update timestamps", async () => {
    mockTask.findMany.mockResolvedValueOnce([])
    await listTasks({
      workspaceId: WORKSPACE_ID,
      status: "IN_REVIEW",
      updatedSince: "2026-09-01T00:00:00.000Z",
      updatedBefore: "2026-09-07T00:00:00.000Z",
    })
    expect(mockTask.findMany.mock.calls[0][0].where).toMatchObject({
      workspaceId: WORKSPACE_ID,
      status: "IN_REVIEW",
      updatedAt: {
        gte: new Date("2026-09-01T00:00:00.000Z"),
        lt: new Date("2026-09-07T00:00:00.000Z"),
      },
    })
  })

  it("treats explicit null parentTaskId as top-level-only filter", async () => {
    mockTask.findMany.mockResolvedValueOnce([])
    await listTasks({ workspaceId: WORKSPACE_ID, parentTaskId: null })
    const where = mockTask.findMany.mock.calls[0][0].where
    expect(where.parentTaskId).toBeNull()
  })

  it("omits parentTaskId filter when not provided", async () => {
    mockTask.findMany.mockResolvedValueOnce([])
    await listTasks({ workspaceId: WORKSPACE_ID })
    const where = mockTask.findMany.mock.calls[0][0].where
    expect("parentTaskId" in where).toBe(false)
  })

  it("filters by linkedType + linkedId together", async () => {
    mockTask.findMany.mockResolvedValueOnce([])
    await listTasks({ workspaceId: WORKSPACE_ID, linkedType: "OPPORTUNITY", linkedId: OPP_ID })
    const where = mockTask.findMany.mock.calls[0][0].where
    expect(where.links).toEqual({ some: { linkedType: "OPPORTUNITY", linkedId: OPP_ID } })
  })

  it("lists tasks flat with subtask counts", async () => {
    const createdAt = new Date("2026-08-01T00:00:00.000Z")
    const updatedAt = new Date("2026-09-01T00:00:00.000Z")
    mockTask.findMany.mockResolvedValueOnce([
      { id: "t-1", title: "Epic A", status: "TODO", priority: "HIGH", parentTaskId: null, createdAt, updatedAt, _count: { subtasks: 2 } },
    ])
    const result = await listTasks({ workspaceId: WORKSPACE_ID })
    const text = textOf(result)
    expect(text).toContain("Epic A")
    expect(text).toContain("2 subtask(s)")
    expect(text).toContain("ID: t-1")
    expect(result.structuredContent.data).toMatchObject({
      items: [{ id: "t-1", createdAt, updatedAt }],
    })
  })

  it("nests subtasks under their parent when includeSubtasks is set", async () => {
    mockTask.findMany.mockResolvedValueOnce([
      { id: "epic-1", title: "Epic A", status: "TODO", priority: "HIGH", parentTaskId: null, _count: { subtasks: 1 } },
      { id: "sub-1", title: "Child A", status: "IN_PROGRESS", priority: "MEDIUM", parentTaskId: "epic-1", _count: { subtasks: 0 } },
    ])
    const result = await listTasks({ workspaceId: WORKSPACE_ID, includeSubtasks: true })
    const text = textOf(result)
    expect(text).toContain("Epic A")
    expect(text).toContain("↳ [IN_PROGRESS] Child A")
  })
})

// ─── updateTask ───────────────────────────────────────────────────────────────

describe("updateTask", () => {
  it("returns a not-found message when the task does not exist", async () => {
    mockTask.findUnique.mockResolvedValueOnce(null)
    const result = await updateTask({ taskId: "missing-task", title: "X" })
    expect(textOf(result)).toContain("not found")
    expect(mockTask.update).not.toHaveBeenCalled()
  })

  it("updates only provided fields and always bumps updatedAt", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID })
    await updateTask({ taskId: TASK_ID, title: "Renamed", storyPoints: 8 })
    const call = mockTask.update.mock.calls[0][0]
    expect(call.where).toEqual({ id: TASK_ID })
    expect(call.data.title).toBe("Renamed")
    expect(call.data.storyPoints).toBe(8)
    expect(call.data.description).toBeUndefined()
    expect(call.data.updatedAt).toBeInstanceOf(Date)
  })

  it("clears a field when explicitly passed null", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID })
    await updateTask({ taskId: TASK_ID, assigneeUserId: null, dueDate: null })
    const call = mockTask.update.mock.calls[0][0]
    expect(call.data.assigneeUserId).toBeNull()
    expect(call.data.dueDate).toBeNull()
  })

  it("does not accept a status field (state machine lives in move_task_status)", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID })
    // @ts-expect-error status is intentionally not part of the update signature
    await updateTask({ taskId: TASK_ID, status: "DONE" })
    const call = mockTask.update.mock.calls[0][0]
    expect(call.data.status).toBeUndefined()
  })

  it("returns a bare ID line", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID })
    const result = await updateTask({ taskId: TASK_ID, title: "Renamed" })
    const text = textOf(result)
    expect(text).toContain(`ID: ${TASK_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})

// ─── moveTaskStatus ───────────────────────────────────────────────────────────

describe("moveTaskStatus", () => {
  it("returns a not-found message when the task does not exist", async () => {
    mockTask.findUnique.mockResolvedValueOnce(null)
    const result = await moveTaskStatus({ taskId: "missing-task", status: "BLOCKED" })
    expect(textOf(result)).toContain("not found")
    expect(mockTask.update).not.toHaveBeenCalled()
  })

  it("moves to BLOCKED as a first-class status, placed at end of column", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID, title: "Ship payments", workspaceId: WORKSPACE_ID })
    mockTask.findFirst.mockResolvedValueOnce({ sortOrder: 2 })

    const result = await moveTaskStatus({ taskId: TASK_ID, status: "BLOCKED" })

    const data = mockTask.update.mock.calls[0][0].data
    expect(data.status).toBe("BLOCKED")
    expect(data.sortOrder).toBe(3)
    expect(data.updatedAt).toBeInstanceOf(Date)

    const text = textOf(result)
    expect(text).toContain("BLOCKED")
    expect(text).toContain(`ID: ${TASK_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("places at sortOrder 0 when the destination column is empty", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID, title: "Ship payments", workspaceId: WORKSPACE_ID })
    mockTask.findFirst.mockResolvedValueOnce(null)
    await moveTaskStatus({ taskId: TASK_ID, status: "DONE" })
    const data = mockTask.update.mock.calls[0][0].data
    expect(data.sortOrder).toBe(0)
  })

  it("excludes the task itself from the destination-column lookup", async () => {
    mockTask.findUnique.mockResolvedValueOnce({ id: TASK_ID, title: "Ship payments", workspaceId: WORKSPACE_ID })
    await moveTaskStatus({ taskId: TASK_ID, status: "IN_REVIEW" })
    const where = mockTask.findFirst.mock.calls[0][0].where
    expect(where.NOT).toEqual({ id: TASK_ID })
  })
})

// ─── linkTask ─────────────────────────────────────────────────────────────────

describe("linkTask", () => {
  it("returns a not-found message when the task does not exist", async () => {
    mockTask.findUnique.mockResolvedValueOnce(null)
    const result = await linkTask({ taskId: "missing-task", linkedType: "OPPORTUNITY", linkedId: OPP_ID })
    expect(textOf(result)).toContain("not found")
    expect(mockTaskLink.create).not.toHaveBeenCalled()
  })

  it("returns a not-found message when the linked target does not exist", async () => {
    mockOpportunity.findUnique.mockResolvedValueOnce(null)
    const result = await linkTask({ taskId: TASK_ID, linkedType: "OPPORTUNITY", linkedId: "missing-opp" })
    expect(textOf(result)).toContain("not found")
    expect(mockTaskLink.create).not.toHaveBeenCalled()
  })

  it("creates a new link and returns a bare ID line", async () => {
    mockTaskLink.findFirst.mockResolvedValueOnce(null)
    mockTaskLink.create.mockResolvedValueOnce({ id: "link-1" })

    const result = await linkTask({ taskId: TASK_ID, linkedType: "OPPORTUNITY", linkedId: OPP_ID })

    expect(mockTaskLink.create).toHaveBeenCalledWith({
      data: { taskId: TASK_ID, linkedType: "OPPORTUNITY", linkedId: OPP_ID },
    })
    const text = textOf(result)
    expect(text).toContain("Reduce churn")
    expect(text).toContain("ID: link-1")
    expect(text).not.toContain("**ID:**")
  })

  it("is idempotent — re-linking the same pair does not create a duplicate row", async () => {
    mockTaskLink.findFirst.mockResolvedValueOnce({ id: "existing-link" })

    const result = await linkTask({ taskId: TASK_ID, linkedType: "OPPORTUNITY", linkedId: OPP_ID })

    expect(mockTaskLink.create).not.toHaveBeenCalled()
    expect(textOf(result)).toContain("already linked")
  })
})

// ─── unlinkTask ───────────────────────────────────────────────────────────────

describe("unlinkTask", () => {
  it("returns a not-found message when no matching link exists", async () => {
    mockTaskLink.findFirst.mockResolvedValueOnce(null)
    const result = await unlinkTask({ taskId: TASK_ID, linkedType: "OPPORTUNITY", linkedId: OPP_ID })
    expect(textOf(result)).toContain("No link found")
    expect(mockTaskLink.delete).not.toHaveBeenCalled()
  })

  it("deletes the matching link", async () => {
    mockTaskLink.findFirst.mockResolvedValueOnce({ id: "link-1" })
    const result = await unlinkTask({ taskId: TASK_ID, linkedType: "OPPORTUNITY", linkedId: OPP_ID })
    expect(mockTaskLink.delete).toHaveBeenCalledWith({ where: { id: "link-1" } })
    expect(textOf(result)).toContain("Unlinked")
  })
})

// ─── listTaskLinks ────────────────────────────────────────────────────────────

describe("listTaskLinks", () => {
  it("returns a not-found message when the task does not exist", async () => {
    mockTask.findUnique.mockResolvedValueOnce(null)
    const result = await listTaskLinks({ taskId: "missing-task" })
    expect(textOf(result)).toContain("not found")
  })

  it("returns a message when the task has no links", async () => {
    mockTaskLink.findMany.mockResolvedValueOnce([])
    const result = await listTaskLinks({ taskId: TASK_ID })
    expect(textOf(result)).toContain("no links")
  })

  it("groups resolved links by linkedType", async () => {
    mockTaskLink.findMany.mockResolvedValueOnce([
      { id: "link-1", linkedType: "OPPORTUNITY", linkedId: OPP_ID },
    ])
    mockOpportunity.findMany.mockResolvedValueOnce([{ id: OPP_ID, title: "Reduce churn" }])

    const result = await listTaskLinks({ taskId: TASK_ID })
    const text = textOf(result)
    expect(text).toContain("OPPORTUNITY:")
    expect(text).toContain("Reduce churn")
    expect(text).toContain("ID: link-1")
  })
})
