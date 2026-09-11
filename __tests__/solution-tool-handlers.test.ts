/**
 * Unit tests for the Solution MCP tool handlers (update_solution).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------

const mockSolution = {
  findUnique: vi.fn(),
  update: vi.fn(),
}

const mockPrisma = {
  solution: mockSolution,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { updateSolution } from "@/lib/solution-tool-handlers"

// ---------------------------------------------------------------------------

const SOLUTION_ID = "solution-1"

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSolution.findUnique.mockResolvedValue({
    id: SOLUTION_ID,
    title: "Existing solution",
    description: "Existing description",
  })
  mockSolution.update.mockImplementation(({ data }) =>
    Promise.resolve({
      id: SOLUTION_ID,
      title: "Existing solution",
      description: "Existing description",
      ...data,
    })
  )
})

// ---------------------------------------------------------------------------

describe("updateSolution", () => {
  it("returns a not-found message when the solution does not exist", async () => {
    mockSolution.findUnique.mockResolvedValueOnce(null)

    const result = await updateSolution({ solutionId: "missing-id", title: "New title" })

    expect(textOf(result)).toContain("not found")
    expect(mockSolution.update).not.toHaveBeenCalled()
  })

  it("updates only the provided field (title)", async () => {
    await updateSolution({ solutionId: SOLUTION_ID, title: "Revised title" })

    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: SOLUTION_ID },
      data: expect.objectContaining({ title: "Revised title" }),
    })
    const data = mockSolution.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty("description")
  })

  it("updates only the provided field (description)", async () => {
    await updateSolution({ solutionId: SOLUTION_ID, description: "New description" })

    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: SOLUTION_ID },
      data: expect.objectContaining({ description: "New description" }),
    })
    const data = mockSolution.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty("title")
  })

  it("allows clearing the description to an empty string", async () => {
    await updateSolution({ solutionId: SOLUTION_ID, description: "" })

    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: SOLUTION_ID },
      data: expect.objectContaining({ description: "" }),
    })
  })

  it("updates title and description together", async () => {
    await updateSolution({ solutionId: SOLUTION_ID, title: "New title", description: "New description" })

    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: SOLUTION_ID },
      data: expect.objectContaining({ title: "New title", description: "New description" }),
    })
  })

  it("returns fail and does not write when neither title nor description is provided", async () => {
    const result = await updateSolution({ solutionId: SOLUTION_ID })

    expect(textOf(result)).toContain("At least one of title or description")
    expect(mockSolution.update).not.toHaveBeenCalled()
  })

  it("trims whitespace on title", async () => {
    await updateSolution({ solutionId: SOLUTION_ID, title: "  Revised title  " })

    expect(mockSolution.update).toHaveBeenCalledWith({
      where: { id: SOLUTION_ID },
      data: expect.objectContaining({ title: "Revised title" }),
    })
  })

  it("always sets updatedAt explicitly (no DB trigger on DSQL)", async () => {
    await updateSolution({ solutionId: SOLUTION_ID, title: "New title" })

    const data = mockSolution.update.mock.calls[0][0].data
    expect(data.updatedAt).toBeInstanceOf(Date)
  })

  it("returns the updated fields in the response text with a plain ID line", async () => {
    const result = await updateSolution({ solutionId: SOLUTION_ID, title: "New title" })

    const text = textOf(result)
    expect(text).toContain(`ID: ${SOLUTION_ID}`)
    expect(text).not.toContain(`**ID:**`)
    expect(text).toContain("New title")
  })
})
