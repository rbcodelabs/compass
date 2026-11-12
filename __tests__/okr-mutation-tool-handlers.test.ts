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
const mockOpportunity = { updateMany: vi.fn() }
const mockEntityLink = { findMany: vi.fn(), deleteMany: vi.fn() }
const mockRoadmapItem = { updateMany: vi.fn() }
const mockCheckIn = { deleteMany: vi.fn() }
const mockCustomFieldValue = { deleteMany: vi.fn() }
const mockCanvasNodePosition = { deleteMany: vi.fn() }
/** The opportunities pointing at the key result, as the entity_links pointer reader returns them (read BEFORE the delete). */
const mockReadPointers = vi.fn()

const mockPrisma = {
  objective: mockObjective,
  keyResult: mockKeyResult,
  opportunity: mockOpportunity,
  entityLink: mockEntityLink,
  roadmapItem: mockRoadmapItem,
  checkIn: mockCheckIn,
  customFieldValue: mockCustomFieldValue,
  canvasNodePosition: mockCanvasNodePosition,
  $transaction: vi.fn(),
}

vi.mock("@/lib/db", () => ({ default: () => mockPrisma }))
vi.mock("@/lib/links/readers", () => ({
  readEntityLinksOpportunityKeyResultPointer: (...args: unknown[]) => mockReadPointers(...args),
}))

import {
  deleteKeyResult,
  deleteObjective,
  updateKeyResult,
  updateObjective,
} from "@/lib/okr-tool-handlers"

const OBJECTIVE_ID = "objective-1"
const KEY_RESULT_ID = "key-result-1"
const OPPORTUNITY_OBJECTIVE = "OPPORTUNITY_TARGETS_OBJECTIVE"
const OPPORTUNITY_KEY_RESULT = "OPPORTUNITY_TARGETS_KEY_RESULT"

function textOf(result: { content: Array<{ text: string }> }) {
  return result.content[0].text
}

/**
 * The post-delete link drains all go through entity_links; each is a find (ids, take 500) then a delete by ids. The fake tells them
 * apart by the shape of the where clause and serves a configurable backlog per kind, so the tests can assert what was drained and how.
 */
type DrainKind = "legacy" | "pointer" | "task" | "parent"
const kindOf = (where: { OR?: unknown; linkType?: string }): DrainKind =>
  where.OR ? "parent" : where.linkType === OPPORTUNITY_OBJECTIVE ? "legacy" : where.linkType === OPPORTUNITY_KEY_RESULT ? "pointer" : "task"
const backlog: Record<DrainKind, number> = { legacy: 0, pointer: 0, task: 0, parent: 0 }
const events: string[] = []
let lastKind: DrainKind = "parent"
let failKind: DrainKind | null = null
const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }))
const findsOf = (kind: DrainKind) => mockEntityLink.findMany.mock.calls.map(([args]) => args).filter((args) => kindOf(args.where) === kind)

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(backlog, { legacy: 0, pointer: 0, task: 0, parent: 0 })
  events.length = 0
  failKind = null
  mockEntityLink.findMany.mockImplementation(async ({ where, take }: { where: { OR?: unknown; linkType?: string }; take: number }) => {
    const kind = kindOf(where)
    lastKind = kind
    if (failKind === kind) throw new Error("drain failed")
    const n = Math.min(take, backlog[kind])
    backlog[kind] -= n
    return rows(n, kind[0])
  })
  mockEntityLink.deleteMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
    events.push(`${lastKind}-drain:${where.id.in.length}`)
    return { count: where.id.in.length }
  })
  mockReadPointers.mockResolvedValue([{ fromId: "opp-1" }, { fromId: "opp-2" }, { fromId: "opp-3" }])
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

  mockKeyResult.findUnique.mockResolvedValue({ id: KEY_RESULT_ID, title: "Reach 70% activation", objectiveId: "objective-of-kr", objective: { workspaceId: "ws-1" } })
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
  mockKeyResult.findFirst.mockResolvedValue(null)
  mockRoadmapItem.updateMany.mockResolvedValue({ count: 4 })
  mockCheckIn.deleteMany.mockResolvedValue({ count: 5 })
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

  it("removes Objective metadata rows in the transaction and its task links (entity_links only) after it, without deleting linked Tasks", async () => {
    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(mockCustomFieldValue.deleteMany).toHaveBeenCalledWith({
      where: { objectId: OBJECTIVE_ID, field: { objectType: "OBJECTIVE" } },
    })
    expect(mockCanvasNodePosition.deleteMany).toHaveBeenCalledWith({
      where: { entityType: "OBJECTIVE", entityId: OBJECTIVE_ID },
    })
    // Task links of the nine association kinds live only in entity_links: there is no task_links delete any more, only the drain.
    expect(findsOf("task")).toEqual([
      { where: { linkType: "TASK_REFERENCES", toType: "OBJECTIVE", toId: { in: [OBJECTIVE_ID] } }, select: { id: true }, take: 500 },
    ])
  })

  it("removes every link naming the Objective (both origins) AFTER the Objective row is gone", async () => {
    const order: string[] = []
    backlog.parent = 2
    mockEntityLink.findMany.mockImplementationOnce(async ({ where }: { where: { OR?: unknown } }) => {
      order.push("find-links")
      lastKind = kindOf(where)
      backlog.parent = 0
      return [{ id: "l1" }, { id: "l2" }]
    })
    mockEntityLink.deleteMany.mockImplementationOnce(async () => { order.push("delete-links"); return { count: 2 } })
    mockObjective.delete.mockImplementation(async () => { order.push("objective"); return { id: OBJECTIVE_ID } })

    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(findsOf("parent")[0]).toEqual({
      where: { OR: [{ fromType: "OBJECTIVE", fromId: { in: [OBJECTIVE_ID] } }, { toType: "OBJECTIVE", toId: { in: [OBJECTIVE_ID] } }] },
      select: { id: true },
      take: 500,
    })
    expect(order).toEqual(["objective", "find-links", "delete-links"])
  })

  it("a refused delete (child key results) touches no link at all", async () => {
    mockObjective.findUnique.mockResolvedValueOnce({ id: OBJECTIVE_ID, title: "Improve activation", _count: { keyResults: 2 } })
    await deleteObjective({ objectiveId: OBJECTIVE_ID })
    expect(mockEntityLink.findMany).not.toHaveBeenCalled()
    expect(mockEntityLink.deleteMany).not.toHaveBeenCalled()
  })

  it("a failed delete transaction touches no link at all", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("conflict"))
    await expect(deleteObjective({ objectiveId: OBJECTIVE_ID })).rejects.toThrow("conflict")
    expect(mockEntityLink.findMany).not.toHaveBeenCalled()
  })

  it("if the post-delete drain fails the Objective is still deleted and the caller still gets success (logged, swallowed)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    failKind = "parent"
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

  it("atomically touches the pointing opportunities, unlinks every nullable reference, deletes CheckIns, then deletes only the KR", async () => {
    const order: string[] = []
    mockOpportunity.updateMany.mockImplementation(async () => { order.push("opportunities"); return { count: 3 } })
    mockObjective.updateMany.mockImplementation(async () => { order.push("objectives"); return { count: 2 } })
    mockRoadmapItem.updateMany.mockImplementation(async () => { order.push("roadmap"); return { count: 4 } })
    mockCustomFieldValue.deleteMany.mockImplementation(async () => { order.push("customFields"); return { count: 7 } })
    mockCanvasNodePosition.deleteMany.mockImplementation(async () => { order.push("canvas"); return { count: 1 } })
    mockCheckIn.deleteMany.mockImplementation(async () => { order.push("checkins"); return { count: 5 } })
    mockKeyResult.delete.mockImplementation(async () => { order.push("keyResult"); return { id: KEY_RESULT_ID } })

    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1)
    // The pointer is not a column: the opportunities that pointed at the key result (read from entity_links before the delete) are
    // only touched here, and their pointer links are drained after the delete.
    expect(mockOpportunity.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["opp-1", "opp-2", "opp-3"] } },
      data: { updatedAt: expect.any(Date) },
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
      "customFields",
      "canvas",
      "checkins",
      "keyResult",
    ])
  })

  it("touches no opportunity when none pointed at the key result", async () => {
    mockReadPointers.mockResolvedValue([])
    const result = await deleteKeyResult({ keyResultId: KEY_RESULT_ID })
    expect(mockOpportunity.updateMany).not.toHaveBeenCalled()
    expect(result.structuredContent.data).toMatchObject({ unlinkedOpportunities: 0 })
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

  it("reports unlink, child-deletion and link-removal counts with a plain ID line (task, solution and LEGACY links counted separately from the pointers)", async () => {
    Object.assign(backlog, { legacy: 2, pointer: 3, task: 6, parent: 1 })

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

  it("drains, AFTER the key result is gone: the LEGACY links the pointing opportunities had to its objective (never DIRECT), the pointers, the task links and every solution link", async () => {
    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    // The pointers are read from entity_links before the delete, in the key result's workspace.
    expect(mockReadPointers).toHaveBeenCalledWith(mockPrisma, "ws-1", { keyResultIds: [KEY_RESULT_ID] })
    expect(findsOf("legacy")).toEqual([
      { where: { linkType: OPPORTUNITY_OBJECTIVE, fromId: { in: ["opp-1", "opp-2", "opp-3"] }, origin: "LEGACY", toId: "objective-of-kr" }, select: { id: true }, take: 500 },
    ])
    expect(findsOf("pointer")).toEqual([
      { where: { linkType: OPPORTUNITY_KEY_RESULT, toType: "KEY_RESULT", toId: { in: [KEY_RESULT_ID] } }, select: { id: true }, take: 500 },
    ])
    expect(findsOf("task")).toEqual([
      { where: { linkType: "TASK_REFERENCES", toType: "KEY_RESULT", toId: { in: [KEY_RESULT_ID] } }, select: { id: true }, take: 500 },
    ])
    expect(findsOf("parent")).toEqual([
      {
        where: { OR: [{ fromType: "KEY_RESULT", fromId: { in: [KEY_RESULT_ID] } }, { toType: "KEY_RESULT", toId: { in: [KEY_RESULT_ID] } }] },
        select: { id: true },
        take: 500,
      },
    ])
    expect(mockKeyResult.delete.mock.invocationCallOrder[0]).toBeLessThan(mockEntityLink.findMany.mock.invocationCallOrder[0])
  })

  it("a failed or refused delete transaction leaves every link untouched", async () => {
    mockPrisma.$transaction.mockRejectedValueOnce(new Error("Restrict: key result still referenced"))
    await expect(deleteKeyResult({ keyResultId: KEY_RESULT_ID })).rejects.toThrow("Restrict")
    expect(mockEntityLink.findMany).not.toHaveBeenCalled()
    expect(mockEntityLink.deleteMany).not.toHaveBeenCalled()

    mockRoadmapItem.updateMany.mockRejectedValueOnce(new Error("roadmap cleanup failed"))
    await expect(deleteKeyResult({ keyResultId: KEY_RESULT_ID })).rejects.toThrow("roadmap cleanup failed")
    expect(mockEntityLink.deleteMany).not.toHaveBeenCalled()
  })

  it("if the post-delete drain fails the key result is still deleted and the caller still gets success (logged, swallowed)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    failKind = "parent"
    const result = await deleteKeyResult({ keyResultId: KEY_RESULT_ID })
    expect(result.structuredContent.ok).toBe(true)
    expect(mockKeyResult.delete).toHaveBeenCalled()
    expect(result.structuredContent.data).toMatchObject({ deleted: true, removedSolutionLinks: 0 })
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ event: "typed_links.cleanup_failed", surface: "mcp.deleteKeyResult.solution" })
    log.mockRestore()
  })

  it("does not drain LEGACY links when no opportunity pointed at the KR", async () => {
    mockReadPointers.mockResolvedValue([])

    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(findsOf("legacy")).toEqual([])
  })
})

describe("parent deletes drain links AFTER the delete, in committed passes (DSQL's 3,000-row cap, 4 rows per link)", () => {
  it("deleteObjective drains an objective's links in passes of at most 500, after the transaction", async () => {
    backlog.parent = 1_203
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      events.push("transaction")
      return callback(mockPrisma)
    })

    await deleteObjective({ objectiveId: OBJECTIVE_ID })

    expect(events).toEqual(["transaction", "parent-drain:500", "parent-drain:500", "parent-drain:203"])
  })

  it("deleteKeyResult drains the LEGACY, pointer and remaining links in passes of at most 500, after the transaction", async () => {
    Object.assign(backlog, { legacy: 1_100, pointer: 700, parent: 600 })
    mockPrisma.$transaction.mockImplementation(async (callback) => {
      events.push("transaction")
      return callback(mockPrisma)
    })

    await deleteKeyResult({ keyResultId: KEY_RESULT_ID })

    expect(events).toEqual([
      "transaction",
      "legacy-drain:500", "legacy-drain:500", "legacy-drain:100",
      "pointer-drain:500", "pointer-drain:200",
      "parent-drain:500", "parent-drain:100",
    ])
  })
})
