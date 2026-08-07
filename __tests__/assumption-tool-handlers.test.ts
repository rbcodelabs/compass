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

const mockWorkspace = {
  findFirst: vi.fn(),
}

const mockPrisma = {
  assumption: mockAssumption,
  experiment: mockExperiment,
  evidence: mockEvidence,
  workspace: mockWorkspace,
}

vi.mock("@/lib/db", () => ({
  default: () => mockPrisma,
}))

// Import handlers AFTER the mock is in place
import { updateAssumption, deleteAssumption } from "@/lib/assumption-tool-handlers"

// ---------------------------------------------------------------------------

const ASSUMPTION_ID = "assumption-1"
// Per-user actor who is a member of the owning workspace (membership mock
// below returns truthy). The service actor { userId: null } would bypass the
// membership check entirely; using a real member exercises the full gate.
const MEMBER = { userId: "user-1" }

function textOf(result: { content: { text: string }[] }) {
  return result.content[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  // The default findUnique return is a SUPERSET carrying both the flat fields
  // the handler reads AND the nested solution→opportunity→workspaceId path
  // that assertEntityAccess's resolver reads (mocks ignore `select`), so the
  // same value satisfies both the authz lookup and the handler's own fetch.
  mockAssumption.findUnique.mockResolvedValue({
    id: ASSUMPTION_ID,
    title: "Existing assumption",
    riskLevel: "MEDIUM",
    status: "UNTESTED",
    solution: { opportunity: { workspaceId: "ws-1" } },
  })
  // Membership check passes by default.
  mockWorkspace.findFirst.mockResolvedValue({ id: "ws-1" })
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
  it("denies (throws) when the assumption does not exist — gate resolves it first", async () => {
    mockAssumption.findUnique.mockResolvedValueOnce(null)

    await expect(
      updateAssumption(MEMBER, { assumptionId: "missing-id", title: "New title" })
    ).rejects.toThrow(/not found or access denied/)
    expect(mockAssumption.update).not.toHaveBeenCalled()
  })

  it("denies (throws) when the caller is not a member of the owning workspace", async () => {
    mockWorkspace.findFirst.mockResolvedValueOnce(null) // not a member

    await expect(
      updateAssumption(MEMBER, { assumptionId: ASSUMPTION_ID, title: "New title" })
    ).rejects.toThrow(/not found or access denied/)
    expect(mockAssumption.update).not.toHaveBeenCalled()
  })

  it("updates only the provided fields (title)", async () => {
    await updateAssumption(MEMBER, { assumptionId: ASSUMPTION_ID, title: "  Revised title  " })

    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: ASSUMPTION_ID },
      data: expect.objectContaining({ title: "Revised title" }),
    })
    const data = mockAssumption.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty("riskLevel")
    expect(data).not.toHaveProperty("status")
  })

  it("updates riskLevel and status together", async () => {
    await updateAssumption(MEMBER, { assumptionId: ASSUMPTION_ID, riskLevel: "HIGH", status: "VALIDATED" })

    expect(mockAssumption.update).toHaveBeenCalledWith({
      where: { id: ASSUMPTION_ID },
      data: expect.objectContaining({ riskLevel: "HIGH", status: "VALIDATED" }),
    })
  })

  it("always sets updatedAt explicitly (no DB trigger on DSQL)", async () => {
    await updateAssumption(MEMBER, { assumptionId: ASSUMPTION_ID, title: "New title" })

    const data = mockAssumption.update.mock.calls[0][0].data
    expect(data.updatedAt).toBeInstanceOf(Date)
  })

  it("returns the updated fields in the response text with a plain ID line", async () => {
    const result = await updateAssumption(MEMBER, { assumptionId: ASSUMPTION_ID, status: "TESTING" })

    const text = textOf(result)
    expect(text).toContain(`ID: ${ASSUMPTION_ID}`)
    expect(text).not.toContain(`**ID:**`)
    expect(text).toContain("TESTING")
  })
})

describe("deleteAssumption", () => {
  it("denies (throws) when the assumption does not exist — gate resolves it first", async () => {
    mockAssumption.findUnique.mockResolvedValueOnce(null)

    await expect(
      deleteAssumption(MEMBER, { assumptionId: "missing-id" })
    ).rejects.toThrow(/not found or access denied/)
    expect(mockAssumption.delete).not.toHaveBeenCalled()
  })

  it("denies (throws) when the caller is not a member of the owning workspace", async () => {
    mockWorkspace.findFirst.mockResolvedValueOnce(null) // not a member

    await expect(
      deleteAssumption(MEMBER, { assumptionId: ASSUMPTION_ID })
    ).rejects.toThrow(/not found or access denied/)
    expect(mockAssumption.delete).not.toHaveBeenCalled()
  })

  it("nulls out Experiment and Evidence references before deleting (no FK cascade on DSQL)", async () => {
    await deleteAssumption(MEMBER, { assumptionId: ASSUMPTION_ID })

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

    await deleteAssumption(MEMBER, { assumptionId: ASSUMPTION_ID })

    expect(order.indexOf("assumption.delete")).toBe(order.length - 1)
  })

  it("returns the deleted assumption's title and a plain ID line", async () => {
    const result = await deleteAssumption(MEMBER, { assumptionId: ASSUMPTION_ID })

    const text = textOf(result)
    expect(text).toContain(`ID: ${ASSUMPTION_ID}`)
    expect(text).not.toContain(`**ID:**`)
    expect(text).toContain("Existing assumption")
  })
})
