/**
 * Unit tests for the Assumption MCP tool handlers (update_assumption, delete_assumption).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// --- Prisma mock setup -------------------------------------------------------

const mockAssumption = {
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}

const mockExperiment = {
  updateMany: vi.fn(),
}

const mockEvidence = {
  updateMany: vi.fn(),
}

const mockPrisma = {
  assumption: mockAssumption,
  experiment: mockExperiment,
  evidence: mockEvidence,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { updateAssumption, deleteAssumption } from "@/lib/assumption-tool-handlers"

// ---------------------------------------------------------------------------

const ASSUMPTION_ID = "assumption-1"

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  mockAssumption.findUnique.mockResolvedValue({
    id: ASSUMPTION_ID,
    title: "Existing assumption",
    riskLevel: "MEDIUM",
    status: "UNTESTED",
  })
  mockAssumption.update.mockImplementation(({ data }) =>
    Promise.resolve({
      id: ASSUMPTION_ID,
      title: "Existing assumption",
      riskLevel: "MEDIUM",
      status: "UNTESTED",
      ...data,
    })
  )
  mockAssumption.delete.mockResolvedValue({ id: ASSUMPTION_ID })
  mockExperiment.updateMany.mockResolvedValue({ count: 0 })
  mockEvidence.updateMany.mockResolvedValue({ count: 0 })
})

// ---------------------------------------------------------------------------

describe("updateAssumption", () => {
  it("returns a not-found message when the assumption does not exist", async () => {
    mockAssumption.findUnique.mockResolvedValueOnce(null)

    const result = await updateAssumption({ assumptionId: "missing-id", title: "New title" })

    expect(textOf(result)).toContain("not found")
    expect(mockAssumption.update).not.toHaveBeenCalled()
  })

  it("updates only the provided fields (title)", async () => {
    await updateAssumption({ assumptionId: ASSUMPTION_ID, title: "  Revised title  " })

    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: ASSUMPTION_ID },
      data: expect.objectContaining({ title: "Revised title" }),
    })
    const data = mockAssumption.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty("riskLevel")
    expect(data).not.toHaveProperty("status")
  })

  it("updates riskLevel and status together", async () => {
    await updateAssumption({ assumptionId: ASSUMPTION_ID, riskLevel: "HIGH", status: "VALIDATED" })

    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: ASSUMPTION_ID },
      data: expect.objectContaining({ riskLevel: "HIGH", status: "VALIDATED" }),
    })
  })

  it("updates and returns an assumption description", async () => {
    const result = await updateAssumption({ assumptionId: ASSUMPTION_ID, description: "Why this belief matters" })

    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: ASSUMPTION_ID },
      data: expect.objectContaining({ description: "Why this belief matters" }),
    })
    expect(result.structuredContent.data).toEqual(expect.objectContaining({ description: "Why this belief matters" }))
  })

  it("always sets updatedAt explicitly (no DB trigger on DSQL)", async () => {
    await updateAssumption({ assumptionId: ASSUMPTION_ID, title: "New title" })

    const data = mockAssumption.update.mock.calls[0][0].data
    expect(data.updatedAt).toBeInstanceOf(Date)
  })

  it("returns the updated fields in the response text with a plain ID line", async () => {
    const result = await updateAssumption({ assumptionId: ASSUMPTION_ID, status: "TESTING" })

    const text = textOf(result)
    expect(text).toContain(`ID: ${ASSUMPTION_ID}`)
    expect(text).not.toContain(`**ID:**`)
    expect(text).toContain("TESTING")
  })
})

describe("deleteAssumption", () => {
  it("returns a not-found message when the assumption does not exist", async () => {
    mockAssumption.findUnique.mockResolvedValueOnce(null)

    const result = await deleteAssumption({ assumptionId: "missing-id" })

    expect(textOf(result)).toContain("not found")
    expect(mockAssumption.delete).not.toHaveBeenCalled()
  })

  it("nulls out Experiment and Evidence references before deleting (no FK cascade on DSQL)", async () => {
    await deleteAssumption({ assumptionId: ASSUMPTION_ID })

    expect(mockExperiment.updateMany).toHaveBeenCalledWith({
      where: { assumptionId: ASSUMPTION_ID },
      data: { assumptionId: null },
    })
    expect(mockEvidence.updateMany).toHaveBeenCalledWith({
      where: { assumptionId: ASSUMPTION_ID },
      data: { assumptionId: null },
    })
    expect(mockAssumption.delete).toHaveBeenCalledWith({ where: { id: ASSUMPTION_ID } })
  })

  it("nulls out references before the delete call, not after", async () => {
    const order: string[] = []
    mockExperiment.updateMany.mockImplementation(() => {
      order.push("experiment.updateMany")
      return Promise.resolve({ count: 0 })
    })
    mockEvidence.updateMany.mockImplementation(() => {
      order.push("evidence.updateMany")
      return Promise.resolve({ count: 0 })
    })
    mockAssumption.delete.mockImplementation(() => {
      order.push("assumption.delete")
      return Promise.resolve({ id: ASSUMPTION_ID })
    })

    await deleteAssumption({ assumptionId: ASSUMPTION_ID })

    expect(order.indexOf("assumption.delete")).toBe(order.length - 1)
  })

  it("returns the deleted assumption's title and a plain ID line", async () => {
    const result = await deleteAssumption({ assumptionId: ASSUMPTION_ID })

    const text = textOf(result)
    expect(text).toContain(`ID: ${ASSUMPTION_ID}`)
    expect(text).not.toContain(`**ID:**`)
    expect(text).toContain("Existing assumption")
  })
})
