/**
 * Direction B — "decisions produce work".
 *
 * Covers the three pieces the decided-decision surface needs: drafting a Task
 * from the decision, suggesting who should own it, and creating + linking it
 * in one step.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const prisma = {
  reviewRequest: { findFirst: vi.fn() },
  task: { create: vi.fn(), findFirst: vi.fn() },
  taskLink: { create: vi.fn(), findFirst: vi.fn() },
  agent: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => prisma }))

// vi.mock is hoisted above module-level consts, so the spy has to be created
// inside vi.hoisted() or the factory runs before it is initialized.
const { eligible } = vi.hoisted(() => ({ eligible: vi.fn() }))
vi.mock("@/lib/task-assignment", () => ({ eligibleTaskAssignees: eligible }))

import {
  buildFollowUpDraft,
  createDecisionFollowUpTask,
  suggestFollowUpAssignee,
} from "@/lib/decision-followthrough"

describe("buildFollowUpDraft", () => {
  it("uses the decision question as the task title", () => {
    const draft = buildFollowUpDraft({ question: "Should we hold the offline experiment?", outcomeLabel: "Approve", rationale: "Corpus is not ready." })
    expect(draft.title).toBe("Should we hold the offline experiment?")
  })

  it("carries the outcome and rationale into the description", () => {
    const draft = buildFollowUpDraft({ question: "Ship it?", outcomeLabel: "Approve", rationale: "Evidence is strong." })
    expect(draft.description).toContain("Approve")
    expect(draft.description).toContain("Evidence is strong.")
  })

  it("omits the rationale section when there is no rationale", () => {
    const draft = buildFollowUpDraft({ question: "Ship it?", outcomeLabel: "Approve", rationale: null })
    expect(draft.description).toContain("Approve")
    expect(draft.description).not.toContain("Rationale")
  })

  it("truncates an over-long question to the Task title limit without cutting mid-word", () => {
    const draft = buildFollowUpDraft({ question: "word ".repeat(80).trim(), outcomeLabel: "Approve", rationale: null })
    expect(draft.title.length).toBeLessThanOrEqual(255)
    expect(draft.title.endsWith("…")).toBe(true)
    expect(draft.title).not.toMatch(/wor…$/)
  })
})

describe("suggestFollowUpAssignee", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eligible.mockResolvedValue([
      { type: "USER", id: "user-1", displayName: "Rick", available: true },
      { type: "AGENT", id: "agent-1", displayName: "Delivery agent", available: true },
    ])
  })

  it("prefers the agent that raised the decision over the API key's owning user", async () => {
    const result = await suggestFollowUpAssignee("ws-1", { requestedByAgentId: "agent-1", requestedById: "user-1" })
    expect(result?.assignee).toEqual({ type: "AGENT", id: "agent-1" })
    expect(result?.provenance).toMatch(/raised this decision/i)
  })

  it("falls back to the requesting user when no agent raised it", async () => {
    const result = await suggestFollowUpAssignee("ws-1", { requestedByAgentId: null, requestedById: "user-1" })
    expect(result?.assignee).toEqual({ type: "USER", id: "user-1" })
  })

  it("suggests nobody when the raiser is no longer an eligible assignee", async () => {
    eligible.mockResolvedValue([{ type: "USER", id: "someone-else", displayName: "Other", available: true }])
    expect(await suggestFollowUpAssignee("ws-1", { requestedByAgentId: "agent-gone", requestedById: "user-gone" })).toBeNull()
  })

  it("suggests nobody when the decision records no requester at all", async () => {
    expect(await suggestFollowUpAssignee("ws-1", { requestedByAgentId: null, requestedById: null })).toBeNull()
  })
})

describe("createDecisionFollowUpTask", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma))
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "DECIDED" })
    prisma.task.findFirst.mockResolvedValue(null)
    prisma.task.create.mockResolvedValue({ id: "task-1", title: "Do the thing" })
    prisma.taskLink.create.mockResolvedValue({ id: "link-1" })
    eligible.mockResolvedValue([{ type: "USER", id: "user-1", displayName: "Rick", available: true }])
  })

  it("creates the task and its DECISION link in one transaction", async () => {
    const result = await createDecisionFollowUpTask({ workspaceId: "ws-1", requestId: "request-1", title: "Do the thing", description: "why", assignee: null })
    expect(prisma.$transaction).toHaveBeenCalled()
    expect(prisma.task.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ workspaceId: "ws-1", title: "Do the thing" }) }))
    expect(prisma.taskLink.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ taskId: "task-1", linkedType: "DECISION", linkedId: "request-1" }) }))
    expect(result).toEqual(expect.objectContaining({ taskId: "task-1", linkId: "link-1" }))
  })

  it("refuses a decision that has not been decided yet", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue({ id: "request-1", workspaceId: "ws-1", gateType: "TRACKED_DECISION", state: "PENDING" })
    await expect(createDecisionFollowUpTask({ workspaceId: "ws-1", requestId: "request-1", title: "x", description: "", assignee: null }))
      .rejects.toThrow(/decided/i)
    expect(prisma.task.create).not.toHaveBeenCalled()
  })

  it("refuses a decision from another workspace", async () => {
    prisma.reviewRequest.findFirst.mockResolvedValue(null)
    await expect(createDecisionFollowUpTask({ workspaceId: "ws-1", requestId: "request-1", title: "x", description: "", assignee: null }))
      .rejects.toThrow(/not found/i)
    expect(prisma.task.create).not.toHaveBeenCalled()
  })

  it("requires a non-empty title", async () => {
    await expect(createDecisionFollowUpTask({ workspaceId: "ws-1", requestId: "request-1", title: "   ", description: "", assignee: null }))
      .rejects.toThrow(/title/i)
    expect(prisma.task.create).not.toHaveBeenCalled()
  })

  it("rejects an assignee who is not eligible in the workspace", async () => {
    await expect(createDecisionFollowUpTask({ workspaceId: "ws-1", requestId: "request-1", title: "x", description: "", assignee: { type: "USER", id: "stranger" } }))
      .rejects.toThrow(/assignee/i)
    expect(prisma.task.create).not.toHaveBeenCalled()
  })
})
