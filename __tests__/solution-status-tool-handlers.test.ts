import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SolutionStatus } from "@/lib/types"

const mockSolution = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

vi.mock("@/lib/db", () => ({
  default: () => ({ solution: mockSolution }),
}))

import { updateSolutionStatus } from "@/lib/solution-status-tool-handlers"

const SOLUTION_ID = "7df95340-297e-40e7-b021-42e2ecbf22e3"

beforeEach(() => {
  vi.clearAllMocks()
  mockSolution.findUnique.mockResolvedValue({
    id: SOLUTION_ID,
    title: "Reconcile delivered work",
    status: "IDEA",
  })
  mockSolution.update.mockResolvedValue({ id: SOLUTION_ID })
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
