import { beforeEach, describe, expect, it, vi } from "vitest"

const mockObjective = {
  findUnique: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
}
const mockKeyResult = {
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}
const mockOpportunity = { updateMany: vi.fn(), findMany: vi.fn() }
const mockOpportunityObjectiveLink = { findMany: vi.fn(), deleteMany: vi.fn() }
const mockSolutionKeyResultLink = { findMany: vi.fn(), deleteMany: vi.fn() }
const mockRoadmapItem = { updateMany: vi.fn() }
const mockCheckIn = { deleteMany: vi.fn() }
const mockTaskLink = { deleteMany: vi.fn() }
const mockCustomFieldValue = { deleteMany: vi.fn() }
const mockCanvasNodePosition = { deleteMany: vi.fn() }

const mockPrisma = {
  objective: mockObjective,
  keyResult: mockKeyResult,
  opportunity: mockOpportunity,
  opportunityObjectiveLink: mockOpportunityObjectiveLink,
  solutionKeyResultLink: mockSolutionKeyResultLink,
  roadmapItem: mockRoadmapItem,
  checkIn: mockCheckIn,
  taskLink: mockTaskLink,
  customFieldValue: mockCustomFieldValue,
  canvasNodePosition: mockCanvasNodePosition,
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))

import {
  deleteKeyResult,
  deleteObjective,
  updateKeyResult,
  updateObjective,
} from "@/lib/okr-tool-handlers"

const OBJECTIVE_ID = "objective-1"
const KEY_RESULT_ID = "key-result-1"

function textOf(result: { content: Array<{ text: string }> }) {
  return result.content[0].text
}

beforeEach(() => {
  vi.clearAllMocks()
  mockObjective.findUnique.mockResolvedValue({
    id: OBJECTIVE_ID,
    title: "Improve activation",
    _count: { keyResults: 0 },
  })
  mockObjective.update.mockImplementation(({ data }) =>
    Promise.resolve({
      id: OBJECTIVE_ID,
      title: "Improve activation",
      description: "Help new teams succeed",
      status: "ON_TRACK",
      ...data,
    })
  )
  mockObjective.updateMany.mockResolvedValue({ count: 2 })
  mockObjective.delete.mockResolvedValue({ id: OBJECTIVE_ID })

  mockKeyResult.findUnique.mockResolvedValue({ id: KEY_RESULT_ID, title: "Reach 70% activation", objectiveId: "objective-of-kr" })
  mockKeyResult.update.mockImplementation(({ data }) =>
    Promise.resolve({
      id: KEY_RESULT_ID,
      title: "Reach 70% activation",
      target: 70,
      current: 40,
      unit: "%",
      ...data,
    })
  )
  mockKeyResult.delete.mockResolvedValue({ id: KEY_RESULT_ID })
  mockOpportunity.updateMany.mockResolvedValue({ count: 3 })
  mockOpportunity.findMany.mockResolvedValue([{ id: "opp-1" }, { id: "opp-2" }, { id: "opp-3" }])
  mockKeyResult.findFirst.mockResolvedValue(null)
  mockOpportunityObjectiveLink.findMany.mockResolvedValue([])
  mockSolutionKeyResultLink.findMany.mockResolvedValue([])
  mockOpportunityObjectiveLink.deleteMany.mockResolvedValue({ count: 2 })
  mockSolutionKeyResultLink.deleteMany.mockResolvedValue({ count: 1 })
  mockRoadmapItem.updateMany.mockResolvedValue({ count: 4 })
  mockCheckIn.deleteMany.mockResolvedValue({ count: 5 })
  mockTaskLink.deleteMany.mockResolvedValue({ count: 6 })
  mockCustomFieldValue.deleteMany.mockResolvedValue({ count: 7 })
  mockCanvasNodePosition.deleteMany.mockResolvedValue({ count: 1 })
  mockPrisma.$transaction.mockImplementation(async (callback) => callback(mockPrisma))
})

describe("updateObjective", () => {
  it("returns ok=false and does not update a missing Objective", async () => {
    mockObjective.findUnique.mockResolvedValueOnce(null)

    const result = await updateObjective({ objectiveId: "missing", title: "New title" })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toContain("not found")
    expect(mockObjective.update).not.toHaveBeenCalled()
  })

  it("updates only supplied fields, trims text, and explicitly sets updatedAt", async () => {
    await updateObjective({
      objectiveId: OBJECTIVE_ID,
      title: "  Retain activated teams  ",
      status: "AT_RISK",
    })

    const data = mockObjective.update.mock.calls[0][0].data
    expect(data).toMatchObject({ title: "Retain activated teams", status: "AT_RISK" })
    expect(data.updatedAt).toBeInstanceOf(Date)
    expect(data).not.toHaveProperty("description")
  })

  it("can clear a nullable description", async () => {
    await updateObjective({ objectiveId: OBJECTIVE_ID, description: null })

    expect(mockObjective.update.mock.calls[0][0].data.description).toBeNull()
  })

  it("returns the updated Objective with a plain ID line", async () => {
    const result = await updateObjective({ objectiveId: OBJECTIVE_ID, status: "COMPLETE" })

    expect(result.structuredContent.ok).toBe(true)
    expect(textOf(result)).toContain(`ID: ${OBJECTIVE_ID}`)
    expect(textOf(result)).not.toContain("**ID:**")
    expect(result.structuredContent.data).toMatchObject({ id: OBJECTIVE_ID, status: "COMPLETE" })
  })
})

describe("deleteObjective", () => {
  it("returns ok=false and does not delete a missing Objective", async () => {
    mockObjective.findUnique.mockResolvedValueOnce(null)

    const result = await deleteObjective({ objectiveId: "missing" })

    expect(result.structuredContent.ok).toBe(false)
    expect(mockObjective.delete).not.toHaveBeenCalled()
  })

  it("refuses deletion when child Key Results exist and reports their count", async () => {
    mockObjective.findUnique.mockResolvedValueOnce({
      id: OBJECTIVE_ID,
      title: "Improve activation",
      _count: { keyResults: 2 },
    })

    const result = await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(result.structuredContent.ok).toBe(false)
    expect(textOf(result)).toContain("2 child Key Results")
    expect(mockObjective.delete).not.toHaveBeenCalled()
  })

  it("checks for children and deletes within one transaction", async () => {
    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockObjective.findUnique).toHaveBeenCalledWith({
      where: { id: OBJECTIVE_ID },
      select: { id: true, title: true, _count: { select: { keyResults: true } } },
    })
    expect(mockObjective.delete).toHaveBeenCalledWith({ where: { id: OBJECTIVE_ID } })
  })

  it("removes Objective link and metadata rows without deleting linked Tasks", async () => {
    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(mockTaskLink.deleteMany).toHaveBeenCalledWith({
      where: { linkedType: "OBJECTIVE", linkedId: OBJECTIVE_ID },
    })
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({
      where: { objectId: OBJECTIVE_ID, field: { objectType: "OBJECTIVE" } },
    })
    expect(mockCanvasNodePosition.deleteMany).toHaveBeenCalledWith({
      where: { entityType: "OBJECTIVE", entityId: OBJECTIVE_ID },
    })
  })

  it("removes every opportunity link to the Objective (both origins) AFTER the Objective row is gone", async () => {
    const order: string[] = []
    mockOpportunityObjectiveLink.findMany.mockImplementationOnce(async () => { order.push("find-links"); return [{ id: "l1" }, { id: "l2" }] })
    mockOpportunityObjectiveLink.deleteMany.mockImplementation(async () => { order.push("delete-links"); return { count: 2 } })
    mockObjective.delete.mockImplementation(async () => { order.push("objective"); return { id: OBJECTIVE_ID } })

    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(mockOpportunityObjectiveLink.findMany).toHaveBeenCalledWith({ where: { objectiveId: { in: [OBJECTIVE_ID] } }, select: { id: true }, take: 500 })
    expect(order).toEqual(["objective", "find-links", "delete-links"])
  })

  it("a refused delete (child key results) touches no link at all", async () => {
    mockObjective.findUnique.mockResolvedValueOnce({ id: OBJECTIVE_ID, title: "Improve activation", _count: { keyResults: 2 } })
    await deleteObjective({ objectiveId: OBJECTIVE_ID })
    expect(mockOpportunityObjectiveLink.findMany).not.toHaveBeenCalled()
    expect(mockOpportunityObjectiveLink.deleteMany).not.toHaveBeenCalled()
  })

  it("a failed delete transaction touches no link at all", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("conflict"))
    await expect(deleteObjective({ objectiveId: OBJECTIVE_ID })).rejects.toThrow("conflict")
    expect(mockOpportunityObjectiveLink.findMany).not.toHaveBeenCalled()
  })

  it("if the post-delete drain fails the Objective is still deleted and the caller still gets success (logged, swallowed)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    mockOpportunityObjectiveLink.findMany.mockRejectedValueOnce(new Error("drain failed"))
    const result = await deleteObjective({ objectiveId: OBJECTIVE_ID })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockObjective.delete).toHaveBeenCalled()
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "typed_links.cleanup_failed", surface: "mcp.deleteObjective" })
    log.mockRestore()
  })

  it("deletes a childless Objective and returns a plain ID line", async () => {
    const result = await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(mockObjective.delete).toHaveBeenCalledWith({ where: { id: OBJECTIVE_ID } })
    expect(result.structuredContent.ok).toBe(true)
    expect(textOf(result)).toContain(`ID: ${OBJECTIVE_ID}`)
    expect(result.structuredContent.data).toEqual({ id: OBJECTIVE_ID, deleted: true })
  })
})

describe("updateKeyResult", () => {
  it("returns ok=false and does not update a missing Key Result", async () => {
    mockKeyResult.findUnique.mockResolvedValueOnce(null)

    const result = await updateKeyResult({ keyResultId: "missing", current: 10 })

    expect(result.structuredContent.ok).toBe(false)
    expect(mockKeyResult.update).not.toHaveBeenCalled()
  })

  it("updates only supplied fields and explicitly sets updatedAt", async () => {
    await updateKeyResult({ keyResultId: KEY_RESULT_ID, target: 80, current: 52 })

    const data = mockKeyResult.update.mock.calls[0][0].data
    expect(data).toMatchObject({ target: 80, current: 52 })
    expect(data.updatedAt).toBeInstanceOf(Date)
    expect(data).not.toHaveProperty("title")
    expect(data).not.toHaveProperty("unit")
  })

  it("trims title and can clear a nullable unit", async () => {
    await updateKeyResult({ keyResultId: KEY_RESULT_ID, title: "  Reach 80% activation  ", unit: null })

    expect(mockKeyResult.update.mock.calls[0][0].data).toMatchObject({
      title: "Reach 80% activation",
      unit: null,
    })
  })

  it("returns the updated Key Result with a plain ID line", async () => {
    const result = await updateKeyResult({ keyResultId: KEY_RESULT_ID, current: 55 })

    expect(result.structuredContent.ok).toBe(true)
    expect(textOf(result)).toContain(`ID: ${KEY_RESULT_ID}`)
    expect(textOf(result)).not.toContain("**ID:**")
    expect(result.structuredContent.data).toMatchObject({ id: KEY_RESULT_ID, current: 55 })
  })
})

describe("deleteKeyResult", () => {
  it("returns ok=false without starting a transaction for a missing Key Result", async () => {
    mockKeyResult.findUnique.mockResolvedValueOnce(null)

    const result = await deleteKeyResult({ keyResultId: "missing" })

    expect(result.structuredContent.ok).toBe(false)
    expect(mockPrisma.$transaction).not.toHaveBeenCalled()
    expect(mockKeyResult.delete).not.toHaveBeenCalled()
  })

  it("atomically unlinks every nullable reference, deletes CheckIns, then deletes only the KR", async () => {
    const order: string[] = []
    mockOpportunity.updateMany.mockImplementation(async () => { order.push("opportunities"); return { count: 3 } })
    mockObjective.updateMany.mockImplementation(async () => { order.push("objectives"); return { count: 2 } })
    mockRoadmapItem.updateMany.mockImplementation(async () => { order.push("roadmap"); return { count: 4 } })
    mockTaskLink.deleteMany.mockImplementation(async () => { order.push("taskLinks"); return { count: 6 } })
    mockCustomFieldValue.deleteMany.mockImplementation(async () => { order.push("customFields"); return { count: 7 } })
    mockCanvasNodePosition.deleteMany.mockImplementation(async () => { order.push("canvas"); return { count: 1 } })
    mockCheckIn.deleteMany.mockImplementation(async () => { order.push("checkins"); return { count: 5 } })
    mockKeyResult.delete.mockImplementation(async () => { order.push("keyResult"); return { id: KEY_RESULT_ID } })

    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockOpportunity.updateMany).toHaveBeenCalledWith({
      where: { linkedKeyResultId: KEY_RESULT_ID },
      data: { linkedKeyResultId: null, updatedAt: expect.any(Date) },
    })
    expect(mockObjective.updateMany).toHaveBeenCalledWith({
      where: { parentKeyResultId: KEY_RESULT_ID },
      data: { parentKeyResultId: null, updatedAt: expect.any(Date) },
    })
    expect(mockRoadmapItem.updateMany).toHaveBeenCalledWith({
      where: { keyResultId: KEY_RESULT_ID },
      data: { keyResultId: null, updatedAt: expect.any(Date) },
    })
    expect(mockCheckIn.deleteMany).toHaveBeenCalledWith({ where: { keyResultId: KEY_RESULT_ID } })
    expect(mockTaskLink.deleteMany).toHaveBeenCalledWith({
      where: { linkedType: "KEY_RESULT", linkedId: KEY_RESULT_ID },
    })
    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({
      where: { objectId: KEY_RESULT_ID, field: { objectType: "KEY_RESULT" } },
    })
    expect(mockCanvasNodePosition.deleteMany).toHaveBeenCalledWith({
      where: { entityType: "KEY_RESULT", entityId: KEY_RESULT_ID },
    })
    expect(mockKeyResult.delete).toHaveBeenCalledWith({ where: { id: KEY_RESULT_ID } })
    expect(order).toEqual([
      "opportunities",
      "objectives",
      "roadmap",
      "taskLinks",
      "customFields",
      "canvas",
      "checkins",
      "keyResult",
    ])
  })

  it("propagates a transaction failure and never retries outside the transaction", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("transaction rolled back"))

    await expect(deleteKeyResult({ keyResultId: KEY_RESULT_ID })).rejects.toThrow("transaction rolled back")

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    expect(mockKeyResult.delete).not.toHaveBeenCalled()
  })

  it("does not delete the KR when any reference cleanup fails", async () => {
    mockRoadmapItem.updateMany.mockRejectedValueOnce(new Error("roadmap cleanup failed"))

    await expect(deleteKeyResult({ keyResultId: KEY_RESULT_ID })).rejects.toThrow("roadmap cleanup failed")

    expect(mockKeyResult.delete).not.toHaveBeenCalled()
  })

  it("reports unlink, child-deletion and link-removal counts with a plain ID line", async () => {
    mockOpportunityObjectiveLink.findMany.mockResolvedValueOnce([{ id: "l1" }, { id: "l2" }])
    mockSolutionKeyResultLink.findMany.mockResolvedValueOnce([{ id: "s1" }])
    mockOpportunityObjectiveLink.deleteMany.mockResolvedValue({ count: 2 })
    mockSolutionKeyResultLink.deleteMany.mockResolvedValue({ count: 1 })

    const result = await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(result.structuredContent.ok).toBe(true)
    expect(textOf(result)).toContain(`ID: ${KEY_RESULT_ID}`)
    expect(result.structuredContent.data).toEqual({
      id: KEY_RESULT_ID,
      deleted: true,
      unlinkedOpportunities: 3,
      unlinkedObjectives: 2,
      unlinkedRoadmapItems: 4,
      removedTaskLinks: 6,
      deletedCustomFieldValues: 7,
      deletedCanvasPositions: 1,
      deletedCheckIns: 5,
      removedOpportunityLinks: 2,
      removedSolutionLinks: 1,
    })
  })

  it("drains, AFTER the key result is gone: the LEGACY links the unlinked opportunities had to this key result's objective (never DIRECT), and every solution link", async () => {
    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    // The pointers are read before the delete, since the transaction nulls them.
    expect(mockOpportunity.findMany).toHaveBeenCalledWith({ where: { linkedKeyResultId: KEY_RESULT_ID }, select: { id: true } })
    expect(mockOpportunityObjectiveLink.findMany).toHaveBeenCalledWith({
      where: { opportunityId: { in: ["opp-1", "opp-2", "opp-3"] }, origin: "LEGACY", objectiveId: "objective-of-kr" },
      select: { id: true },
      take: 500,
    })
    expect(mockSolutionKeyResultLink.findMany).toHaveBeenCalledWith({ where: { keyResultId: { in: [KEY_RESULT_ID] } }, select: { id: true }, take: 500 })
    expect(mockKeyResult.delete.mock.invocationCallOrder[0]).toBeLessThan(mockOpportunityObjectiveLink.findMany.mock.invocationCallOrder[0])
    expect(mockKeyResult.delete.mock.invocationCallOrder[0]).toBeLessThan(mockSolutionKeyResultLink.findMany.mock.invocationCallOrder[0])
  })

  it("a failed or refused delete transaction leaves every link untouched", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("Restrict: key result still referenced"))
    await expect(deleteKeyResult({ keyResultId: KEY_RESULT_ID })).rejects.toThrow("Restrict")
    expect(mockOpportunityObjectiveLink.findMany).not.toHaveBeenCalled()
    expect(mockOpportunityObjectiveLink.deleteMany).not.toHaveBeenCalled()
    expect(mockSolutionKeyResultLink.findMany).not.toHaveBeenCalled()
    expect(mockSolutionKeyResultLink.deleteMany).not.toHaveBeenCalled()

    mockRoadmapItem.updateMany.mockRejectedValueOnce(new Error("roadmap cleanup failed"))
    await expect(deleteKeyResult({ keyResultId: KEY_RESULT_ID })).rejects.toThrow("roadmap cleanup failed")
    expect(mockSolutionKeyResultLink.deleteMany).not.toHaveBeenCalled()
  })

  it("if the post-delete drain fails the key result is still deleted and the caller still gets success (logged, swallowed)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    mockSolutionKeyResultLink.findMany.mockRejectedValueOnce(new Error("drain failed"))
    const result = await deleteKeyResult({ keyResultId: KEY_RESULT_ID })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockKeyResult.delete).toHaveBeenCalled()
    expect(result.structuredContent.data).toMatchObject({ deleted: true, removedSolutionLinks: 0 })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "typed_links.cleanup_failed", surface: "mcp.deleteKeyResult.solution" })
    log.mockRestore()
  })

  it("does not read link rows for the pointer drain when no opportunity pointed at the KR", async () => {
    mockOpportunity.findMany.mockResolvedValue([])

    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(mockOpportunityObjectiveLink.findMany).not.toHaveBeenCalled()
  })
})

describe("parent deletes drain links AFTER the delete, in committed passes (DSQL's 3,000-row cap, 4 rows per link)", () => {
  const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))

  it("deleteObjective drains an objective's links in passes of at most 500, after the transaction", async () => {
    const events: string[] = []
    let remaining = 1_203
    mockOpportunityObjectiveLink.findMany.mockImplementation(async ({ take }: { take: number }) => {
      const n = Math.min(take, remaining)
      remaining -= n
      return rows(n, "l")
    })
    mockOpportunityObjectiveLink.deleteMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) => {
      events.push(`drain:${where.id?.in.length}`)
      return { count: where.id ? where.id.in.length : 0 }
    })
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      events.push("transaction")
      return callback(mockPrisma)
    })

    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(events).toEqual(["transaction", "drain:500", "drain:500", "drain:203"])
  })

  it("deleteKeyResult drains the LEGACY and solution links in passes of at most 500, after the transaction", async () => {
    const events: string[] = []
    let legacy = 1_100
    let solution = 600
    mockOpportunityObjectiveLink.findMany.mockImplementation(async ({ where, take }: { where: { origin?: string }; take: number }) => {
      expect(where.origin).toBe("LEGACY")
      const n = Math.min(take, legacy)
      legacy -= n
      return rows(n, "l")
    })
    mockSolutionKeyResultLink.findMany.mockImplementation(async ({ take }: { take: number }) => {
      const n = Math.min(take, solution)
      solution -= n
      return rows(n, "s")
    })
    mockOpportunityObjectiveLink.deleteMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) => {
      events.push(`legacy-drain:${where.id?.in.length}`)
      return { count: where.id ? where.id.in.length : 0 }
    })
    mockSolutionKeyResultLink.deleteMany.mockImplementation(async ({ where }: { where: { id?: { in: string[] } } }) => {
      events.push(`solution-drain:${where.id?.in.length}`)
      return { count: where.id ? where.id.in.length : 0 }
    })
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      events.push("transaction")
      return callback(mockPrisma)
    })

    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(events).toEqual(["transaction", "legacy-drain:500", "legacy-drain:500", "legacy-drain:100", "solution-drain:500", "solution-drain:100"])
  })
})
