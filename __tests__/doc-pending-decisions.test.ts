import { beforeEach, describe, expect, it, vi } from "vitest"

const findMany = vi.fn()
vi.mock("@/lib/db", () => ({ default: () => ({ reviewRequest: { findMany } }) }))
import * as decisions from "@/lib/tracked-decisions"

const docId = "00000000-0000-4000-8000-000000000001"
const packet = (entity = { type: "DOC", id: docId }, schemaVersion = "tracked-decision/v2") => JSON.stringify({ schemaVersion, entity, sources: [], question: "Ready?", context: "Review this." })
const row = (id: string, raw = packet()) => ({ id, updatedAt: new Date("2026-09-10"), currentRevision: { title: `Question ${id}`, packetJson: raw } })

describe("pending decisions for a document", () => {
  beforeEach(() => { findMany.mockReset(); findMany.mockResolvedValue([]) })
  it("returns no requests when there are no candidates", async () => {
    expect(await decisions.listPendingDocDecisions("workspace", docId)).toEqual([])
  })
  it("selects only current pending tracked candidates inside the workspace, in stable newest order", async () => {
    findMany.mockResolvedValue([row("one")])
    expect(await decisions.listPendingDocDecisions("workspace", docId)).toEqual([{ id: "one", title: "Question one" }])
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "workspace", gateType: "TRACKED_DECISION", state: "PENDING" }), orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 100 }))
    expect(findMany.mock.calls[0][0].where.OR).toContainEqual({ currentRevision: { is: { packetJson: { contains: docId } } } })
  })
  it("accepts v1 and v2 primary DOC packets, excluding sources, context mentions, other types and ids", async () => {
    findMany.mockResolvedValue([
      row("v1", packet(undefined, "tracked-decision/v1")), row("v2"),
      row("source", JSON.stringify({ schemaVersion: "tracked-decision/v2", entity: { type: "DOC", id: "other" }, sources: [{ type: "DOC", id: docId }] })),
      row("context", JSON.stringify({ schemaVersion: "tracked-decision/v1", entity: { type: "DOC", id: "other" }, context: docId })),
      row("type", packet({ type: "SOLUTION", id: docId })), row("other", packet({ type: "DOC", id: "other" })),
      row("future", packet(undefined, "tracked-decision/v3")),
    ])
    expect(await decisions.listPendingDocDecisions("workspace", docId)).toEqual([{ id: "v1", title: "Question v1" }, { id: "v2", title: "Question v2" }])
  })
  it("reads beyond a full batch without truncating the count", async () => {
    findMany.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => row(String(i)))).mockResolvedValueOnce([row("last")])
    expect(await decisions.listPendingDocDecisions("workspace", docId)).toHaveLength(101)
    expect(findMany.mock.calls[1][0].where.AND).toEqual([{ OR: [{ updatedAt: { lt: new Date("2026-09-10") } }, { updatedAt: new Date("2026-09-10"), id: { lt: "99" } }] }])
  })
  it.each(["{broken", "null", JSON.stringify({ schemaVersion: "tracked-decision/v2" })])("rejects unreadable candidate packets: %s", async raw => {
    findMany.mockResolvedValue([row("broken", raw)])
    await expect(decisions.listPendingDocDecisions("workspace", docId)).rejects.toThrow()
  })
  it("rejects missing current revisions and database failure rather than reporting empty", async () => {
    findMany.mockResolvedValue([{ id: "missing", currentRevision: null }])
    await expect(decisions.listPendingDocDecisions("workspace", docId)).rejects.toThrow()
    findMany.mockRejectedValue(new Error("unavailable"))
    await expect(decisions.listPendingDocDecisions("workspace", docId)).rejects.toThrow("unavailable")
  })
})
