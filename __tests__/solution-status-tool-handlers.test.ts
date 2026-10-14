import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SolutionStatus } from "@/lib/types"

const mockSolution = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

vi.mock("@/lib/db", () => ({
  default: () => ({ solution: mockSolution }),
}))

const { mockSync } = vi.hoisted(() => ({ mockSync: vi.fn() }))
vi.mock("@/lib/roadmap/solution-sync", () => ({ syncRoadmapOnSolutionChange: mockSync }))

import { updateSolutionStatus } from "@/lib/solution-status-tool-handlers"
import { runWithMcpActor } from "@/lib/mcp-authz"

const SOLUTION_ID = "7df95340-297e-40e7-b021-42e2ecbf22e3"

beforeEach(() => {
  vi.clearAllMocks()
  mockSolution.findUnique.mockResolvedValue({
    id: SOLUTION_ID,
    title: "Reconcile delivered work",
    status: "IDEA",
  })
  mockSolution.update.mockResolvedValue({ id: SOLUTION_ID })
  mockSync.mockResolvedValue({ autoAdded: null, skipped: "not-building", followed: 0, error: null })
})

describe("updateSolutionStatus", () => {
  it.each<SolutionStatus>(["IDEA", "VALIDATED", "IN_DELIVERY", "SHIPPED", "KILLED"])(
    "accepts the %s lifecycle status",
    async (status) => {
      mockSolution.findUnique.mockResolvedValueOnce({
        id: SOLUTION_ID,
        title: "Reconcile delivered work",
        status: status === "IDEA" ? "VALIDATED" : "IDEA",
      })

      const result = await updateSolutionStatus({ solutionId: SOLUTION_ID, status })

      expect(mockSolution.update).toHaveBeenCalledWith({
        where: { id: SOLUTION_ID },
        data: { status, updatedAt: expect.any(Date) },
      })
      expect(result.structuredContent.ok).toBe(true)
      expect(result.structuredContent.data).toMatchObject({ id: SOLUTION_ID, status })
    },
  )

  it("returns the standard failure and performs no write when the solution is missing", async () => {
    mockSolution.findUnique.mockResolvedValueOnce(null)

    const result = await updateSolutionStatus({ solutionId: SOLUTION_ID, status: "SHIPPED" })

    expect(result).toEqual({
      content: [{ type: "text", text: `Solution "${SOLUTION_ID}" not found.` }],
      structuredContent: {
        ok: false,
        message: `Solution "${SOLUTION_ID}" not found.`,
        data: null,
      },
    })
    expect(mockSolution.update).not.toHaveBeenCalled()
  })

  it("succeeds idempotently without a write when the solution is already at the requested status", async () => {
    mockSolution.findUnique.mockResolvedValueOnce({
      id: SOLUTION_ID,
      title: "Reconcile delivered work",
      status: "SHIPPED",
    })

    const result = await updateSolutionStatus({ solutionId: SOLUTION_ID, status: "SHIPPED" })

    expect(mockSolution.update).not.toHaveBeenCalled()
    expect(result.content[0].text).toContain("already at SHIPPED")
    expect(result.structuredContent).toEqual({
      ok: true,
      message: expect.stringContaining("already at SHIPPED"),
      data: {
        id: SOLUTION_ID,
        title: "Reconcile delivered work",
        previousStatus: "SHIPPED",
        status: "SHIPPED",
      },
    })
  })

  it("updates only status and explicit updatedAt and returns the observed transition", async () => {
    const before = new Date()

    const result = await updateSolutionStatus({ solutionId: SOLUTION_ID, status: "SHIPPED" })

    const after = new Date()
    expect(mockSolution.update).toHaveBeenCalledTimes(1)
    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: SOLUTION_ID },
      data: { status: "SHIPPED", updatedAt: expect.any(Date) },
    })
    const updatedAt = mockSolution.update.mock.calls[0][0].data.updatedAt as Date
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime())
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime())
    expect(result.content[0].text).toContain("IDEA → SHIPPED")
    expect(result.content[0].text).toContain(`ID: ${SOLUTION_ID}`)
    expect(result.content[0].text).not.toContain(`**ID:**`)
    expect(result.structuredContent.data).toEqual({
      id: SOLUTION_ID,
      title: "Reconcile delivered work",
      previousStatus: "IDEA",
      status: "SHIPPED",
    })
  })
})

describe("updateSolutionStatus: roadmap auto-sync", () => {
  const WORKSPACE_ID = "ws-1"
  const withWorkspace = (status: string) => mockSolution.findUnique.mockResolvedValue({ id: SOLUTION_ID, title: "Adoption dashboard", status, workspaceId: WORKSPACE_ID })
  const asUser = <T,>(run: () => Promise<T>) => runWithMcpActor({ userId: "user-1", purpose: "USER" }, run)

  it("hands the transition to the roadmap sync after the status write, attributed to the calling user", async () => {
    withWorkspace("VALIDATED")
    await asUser(() => updateSolutionStatus({ solutionId: SOLUTION_ID, status: "IN_DELIVERY" }))
    expect(mockSolution.update).toHaveBeenCalled()
    expect(mockSync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "MCP", userId: "user-1" }),
      { solutionId: SOLUTION_ID, workspaceId: WORKSPACE_ID, previousStatus: "VALIDATED", status: "IN_DELIVERY" },
    )
  })

  it("reports the auto-added roadmap item on its own ID line and in the structured data", async () => {
    withWorkspace("VALIDATED")
    mockSync.mockResolvedValue({ autoAdded: { itemId: "item-1", workspaceId: WORKSPACE_ID, title: "Adoption dashboard", start: "2026-10-05", end: "2026-11-15" }, skipped: null, followed: 0, error: null })
    const result = await asUser(() => updateSolutionStatus({ solutionId: SOLUTION_ID, status: "IN_DELIVERY" }))
    expect(result.content[0].text).toContain("Auto-added to the roadmap.")
    expect(result.content[0].text).toContain("Roadmap Item ID: item-1")
    expect(result.structuredContent.data).toMatchObject({ status: "IN_DELIVERY", roadmapItemId: "item-1" })
  })

  it("does not touch the roadmap when the status did not change or the solution has no workspace", async () => {
    withWorkspace("IN_DELIVERY")
    await asUser(() => updateSolutionStatus({ solutionId: SOLUTION_ID, status: "IN_DELIVERY" }))
    expect(mockSync).not.toHaveBeenCalled()
    mockSolution.findUnique.mockResolvedValue({ id: SOLUTION_ID, title: "Legacy", status: "VALIDATED", workspaceId: null })
    await asUser(() => updateSolutionStatus({ solutionId: SOLUTION_ID, status: "IN_DELIVERY" }))
    expect(mockSync).not.toHaveBeenCalled()
  })
})
