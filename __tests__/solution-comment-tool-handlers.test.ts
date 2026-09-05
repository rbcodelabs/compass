/**
 * Unit tests for the SolutionComment MCP tool handlers (add_solution_plan,
 * add_solution_comment, list_solution_comments, get_solution_comment,
 * update_solution_comment, delete_solution_comment, approve_solution_plan,
 * reject_solution_plan).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/comment-compat", () => ({
  mirrorLegacySolutionComment: vi.fn(),
  updateMirroredComment: vi.fn(),
  deleteMirroredComment: vi.fn(),
  updateMirroredLegacyPlanStatus: vi.fn(),
}))

// --- Prisma mock setup -------------------------------------------------------

const mockSolution = {
  findUnique: vi.fn(),
}

const mockSolutionComment = {
  create: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}

const mockPrisma = {
  solution: mockSolution,
  solutionComment: mockSolutionComment,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import {
  addSolutionPlan,
  addSolutionComment,
  listSolutionComments,
  getSolutionComment,
  updateSolutionComment,
  deleteSolutionComment,
  approveSolutionPlan,
  rejectSolutionPlan,
} from "@/lib/solution-comment-tool-handlers"

// ---------------------------------------------------------------------------

const SOLUTION_ID = "solution-1"
const COMMENT_ID = "comment-1"

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

const NOW = new Date("2026-07-27T12:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
  mockSolution.findUnique.mockResolvedValue({ id: SOLUTION_ID, title: "Ship the diff-view rail" })
  mockSolutionComment.create.mockImplementation(({ data }) =>
    Promise.resolve({
      id: COMMENT_ID,
      createdAt: NOW,
      updatedAt: NOW,
      ...data,
    })
  )
  mockSolutionComment.findUnique.mockResolvedValue({
    id: COMMENT_ID,
    solutionId: SOLUTION_ID,
    commentType: "COMMENT",
    body: "Existing comment",
    authorName: "Dev User",
    authorType: "HUMAN",
    source: "UI",
    planStatus: "PENDING",
    createdAt: NOW,
    updatedAt: NOW,
  })
  mockSolutionComment.update.mockImplementation(({ data }) =>
    Promise.resolve({
      id: COMMENT_ID,
      solutionId: SOLUTION_ID,
      commentType: "COMMENT",
      body: "Existing comment",
      authorName: "Dev User",
      authorType: "HUMAN",
      source: "UI",
      createdAt: NOW,
      updatedAt: NOW,
      ...data,
    })
  )
  mockSolutionComment.delete.mockResolvedValue({ id: COMMENT_ID })
  mockSolutionComment.findMany.mockResolvedValue([])
})

// ---------------------------------------------------------------------------

describe("addSolutionPlan", () => {
  it("returns a not-found message when the solution does not exist", async () => {
    mockSolution.findUnique.mockResolvedValueOnce(null)

    const result = await addSolutionPlan({
      solutionId: "missing-id",
      body: "Some plan",
      authorName: "Agent",
    })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.create).not.toHaveBeenCalled()
  })

  it("creates a PLAN comment sourced from MCP, authored by AGENT", async () => {
    await addSolutionPlan({
      solutionId: SOLUTION_ID,
      body: "  Ship behind a flag  ",
      authorName: "Claude",
    })

    expect(mockSolutionComment.create).toHaveBeenCalledWith({
      data: {
        solutionId: SOLUTION_ID,
        commentType: "PLAN",
        body: "Ship behind a flag",
        authorName: "Claude",
        authorType: "AGENT",
        source: "MCP",
      },
    })
  })

  it("returns a plain ID line (no markdown bold)", async () => {
    const result = await addSolutionPlan({
      solutionId: SOLUTION_ID,
      body: "Plan body",
      authorName: "Claude",
    })

    const text = textOf(result)
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})

describe("addSolutionComment", () => {
  it("returns a not-found message when the solution does not exist", async () => {
    mockSolution.findUnique.mockResolvedValueOnce(null)

    const result = await addSolutionComment({
      solutionId: "missing-id",
      body: "Some comment",
      authorName: "Agent",
    })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.create).not.toHaveBeenCalled()
  })

  it("creates a COMMENT sourced from MCP, defaulting authorType to AGENT", async () => {
    await addSolutionComment({
      solutionId: SOLUTION_ID,
      body: "Looks good to me",
      authorName: "Claude",
    })

    expect(mockSolutionComment.create).toHaveBeenCalledWith({
      data: {
        solutionId: SOLUTION_ID,
        commentType: "COMMENT",
        body: "Looks good to me",
        authorName: "Claude",
        authorType: "AGENT",
        source: "MCP",
      },
    })
  })

  it("honors an explicit authorType override", async () => {
    await addSolutionComment({
      solutionId: SOLUTION_ID,
      body: "From a human via an API key",
      authorName: "Rick",
      authorType: "HUMAN",
    })

    const data = mockSolutionComment.create.mock.calls[0][0].data
    expect(data.authorType).toBe("HUMAN")
  })

  it("returns a plain ID line (no markdown bold)", async () => {
    const result = await addSolutionComment({
      solutionId: SOLUTION_ID,
      body: "Comment body",
      authorName: "Claude",
    })

    const text = textOf(result)
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})

describe("listSolutionComments", () => {
  it("returns a not-found message when the solution does not exist", async () => {
    mockSolution.findUnique.mockResolvedValueOnce(null)

    const result = await listSolutionComments({ solutionId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.findMany).not.toHaveBeenCalled()
  })

  it("reports an empty thread distinctly from a missing solution", async () => {
    mockSolutionComment.findMany.mockResolvedValueOnce([])

    const result = await listSolutionComments({ solutionId: SOLUTION_ID })

    expect(textOf(result)).toContain("No comments yet")
  })

  it("queries in chronological order and labels each entry PLAN or COMMENT", async () => {
    mockSolutionComment.findMany.mockResolvedValueOnce([
      {
        id: "c1",
        commentType: "PLAN",
        body: "Initial plan",
        authorName: "Claude",
        authorType: "AGENT",
        planStatus: "PENDING",
        createdAt: NOW,
      },
      {
        id: "c2",
        commentType: "COMMENT",
        body: "Sounds good",
        authorName: "Rick",
        authorType: "HUMAN",
        planStatus: "PENDING",
        createdAt: NOW,
      },
    ])

    const result = await listSolutionComments({ solutionId: SOLUTION_ID })

    expect(mockSolutionComment.findMany).toHaveBeenCalledWith({
      where: { solutionId: SOLUTION_ID },
      orderBy: { createdAt: "asc" },
    })
    const text = textOf(result)
    expect(text).toContain("[PLAN — PENDING]")
    expect(text).toContain("[COMMENT]")
    expect(text).toContain("ID: c1")
    expect(text).toContain("ID: c2")
  })

  it("surfaces the plan's approval status so a caller doesn't need a separate lookup", async () => {
    mockSolutionComment.findMany.mockResolvedValueOnce([
      {
        id: "c1",
        commentType: "PLAN",
        body: "Ship behind a flag",
        authorName: "Claude",
        authorType: "AGENT",
        planStatus: "APPROVED",
        createdAt: NOW,
      },
      {
        id: "c2",
        commentType: "COMMENT",
        body: "Sounds good",
        authorName: "Rick",
        authorType: "HUMAN",
        planStatus: "PENDING",
        createdAt: NOW,
      },
    ])

    const result = await listSolutionComments({ solutionId: SOLUTION_ID })

    const text = textOf(result)
    // The PLAN entry's decision is visible directly in the thread listing...
    expect(text).toContain("APPROVED")
    // ...but COMMENT rows (which always default to PENDING) don't get a
    // meaningless status label cluttering the thread.
    const commentLine = text.split("\n\n").find((block) => block.startsWith("[COMMENT]"))
    expect(commentLine).toBeDefined()
    expect(commentLine).not.toContain("PENDING")
  })
})

describe("getSolutionComment", () => {
  it("returns a not-found message when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null)

    const result = await getSolutionComment({ commentId: "missing-id" })

    expect(textOf(result)).toContain("not found")
  })

  it("returns the comment's type, author, body, and a plain ID line", async () => {
    const result = await getSolutionComment({ commentId: COMMENT_ID })

    const text = textOf(result)
    expect(text).toContain("[COMMENT]");
    expect(text).toContain("Dev User");
    expect(text).toContain("Existing comment");
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
  })

  it("does not show a Status line for a COMMENT (only PLAN entries have one)", async () => {
    const result = await getSolutionComment({ commentId: COMMENT_ID })

    expect(textOf(result)).not.toContain("Status:")
  })

  it("surfaces a PLAN's approval status so a caller doesn't need a separate lookup", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      solutionId: SOLUTION_ID,
      commentType: "PLAN",
      body: "Ship behind a flag",
      authorName: "Claude",
      authorType: "AGENT",
      source: "MCP",
      planStatus: "APPROVED",
      createdAt: NOW,
      updatedAt: NOW,
    })

    const result = await getSolutionComment({ commentId: COMMENT_ID })

    const text = textOf(result)
    expect(text).toContain("[PLAN]")
    expect(text).toContain("Status: APPROVED")
  })
})

describe("updateSolutionComment", () => {
  it("returns a not-found message when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null)

    const result = await updateSolutionComment({ commentId: "missing-id", body: "New body" })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.update).not.toHaveBeenCalled()
  })

  it("trims the body and always sets updatedAt explicitly (no DB trigger on DSQL)", async () => {
    await updateSolutionComment({ commentId: COMMENT_ID, body: "  Revised body  " })

    expect(mockSolutionComment.update).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { body: "Revised body", updatedAt: expect.any(Date) },
    })
  })

  it("returns a plain ID line (no markdown bold)", async () => {
    const result = await updateSolutionComment({ commentId: COMMENT_ID, body: "New body" })

    const text = textOf(result)
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
  })
})

describe("deleteSolutionComment", () => {
  it("returns a not-found message when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null)

    const result = await deleteSolutionComment({ commentId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.delete).not.toHaveBeenCalled()
  })

  it("deletes the comment by id", async () => {
    await deleteSolutionComment({ commentId: COMMENT_ID })

    expect(mockSolutionComment.delete).toHaveBeenCalledWith({ where: { id: COMMENT_ID } })
  })

  it("returns the deleted comment's type and a plain ID line", async () => {
    const result = await deleteSolutionComment({ commentId: COMMENT_ID })

    const text = textOf(result)
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
    expect(text).toContain("COMMENT")
  })
})

describe("approveSolutionPlan", () => {
  it("returns a not-found message when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null)

    const result = await approveSolutionPlan({ commentId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.update).not.toHaveBeenCalled()
  })

  it("refuses to approve a COMMENT (only PLAN entries qualify)", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      commentType: "COMMENT",
      body: "Existing comment",
    })

    const result = await approveSolutionPlan({ commentId: COMMENT_ID })

    expect(textOf(result)).toContain("Only PLAN entries can be approved or rejected")
    expect(mockSolutionComment.update).not.toHaveBeenCalled()
  })

  it("sets planStatus to APPROVED and updatedAt explicitly (no DB trigger on DSQL)", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      commentType: "PLAN",
      body: "Ship behind a flag",
    })

    const result = await approveSolutionPlan({ commentId: COMMENT_ID })

    expect(mockSolutionComment.update).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { planStatus: "APPROVED", updatedAt: expect.any(Date) },
    })
    const text = textOf(result)
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
    expect(text).toContain("approved")
  })
})

describe("rejectSolutionPlan", () => {
  it("returns a not-found message when the comment does not exist", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce(null)

    const result = await rejectSolutionPlan({ commentId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockSolutionComment.update).not.toHaveBeenCalled()
  })

  it("refuses to reject a COMMENT (only PLAN entries qualify)", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      commentType: "COMMENT",
      body: "Existing comment",
    })

    const result = await rejectSolutionPlan({ commentId: COMMENT_ID })

    expect(textOf(result)).toContain("Only PLAN entries can be approved or rejected")
    expect(mockSolutionComment.update).not.toHaveBeenCalled()
  })

  it("sets planStatus to REJECTED and updatedAt explicitly (no DB trigger on DSQL)", async () => {
    mockSolutionComment.findUnique.mockResolvedValueOnce({
      id: COMMENT_ID,
      commentType: "PLAN",
      body: "Ship behind a flag",
    })

    const result = await rejectSolutionPlan({ commentId: COMMENT_ID })

    expect(mockSolutionComment.update).toHaveBeenCalledWith({
      where: { id: COMMENT_ID },
      data: { planStatus: "REJECTED", updatedAt: expect.any(Date) },
    })
    const text = textOf(result)
    expect(text).toContain(`ID: ${COMMENT_ID}`)
    expect(text).not.toContain("**ID:**")
    expect(text).toContain("rejected")
  })
})
