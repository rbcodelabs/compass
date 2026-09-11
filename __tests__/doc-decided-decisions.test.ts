import { beforeEach, describe, expect, it, vi } from "vitest"

const reviewRequestFindMany = vi.fn()
const decisionRecordFindMany = vi.fn()
const userFindUnique = vi.fn()
vi.mock("@/lib/db", () => ({
  default: () => ({
    reviewRequest: { findMany: reviewRequestFindMany },
    decisionRecord: { findMany: decisionRecordFindMany },
    user: { findUnique: userFindUnique },
  }),
}))
import * as decisions from "@/lib/tracked-decisions"

const docId = "00000000-0000-4000-8000-000000000001"
const packet = (entity = { type: "DOC", id: docId }, schemaVersion = "tracked-decision/v2") =>
  JSON.stringify({ schemaVersion, entity, sources: [], question: "Ready?", context: "Review this." })
const record = (requestId: string, raw = packet(), overrides: Record<string, unknown> = {}) => ({
  requestId,
  decidedAt: new Date("2026-09-11T12:00:00.000Z"),
  actorUserId: "actor",
  option: { outcomeClass: "APPROVE", label: "Approve" },
  revision: { title: `Question ${requestId}`, packetJson: raw },
  ...overrides,
})

beforeEach(() => {
  reviewRequestFindMany.mockReset()
  reviewRequestFindMany.mockResolvedValue([])
  decisionRecordFindMany.mockReset()
  decisionRecordFindMany.mockResolvedValue([])
  userFindUnique.mockReset()
  userFindUnique.mockResolvedValue({ name: "Ada Lovelace", email: "ada@example.com" })
})

describe("latest decided decision for a document", () => {
  it("returns null when the document has never been decided", async () => {
    expect(await decisions.findLatestDecidedDocDecision("workspace", docId)).toBeNull()
  })

  it("reads the newest decision for tracked requests in the workspace", async () => {
    decisionRecordFindMany.mockResolvedValue([record("one")])
    expect(await decisions.findLatestDecidedDocDecision("workspace", docId)).toEqual({
      id: "one",
      title: "Question one",
      outcome: "APPROVE",
      outcomeLabel: "Approve",
      decidedAt: new Date("2026-09-11T12:00:00.000Z"),
      reviewerName: "Ada Lovelace",
    })
    expect(decisionRecordFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          workspaceId: "workspace",
          request: { is: { gateType: "TRACKED_DECISION" } },
          revision: { is: { packetJson: { contains: docId } } },
        }),
        // Ordered by when the call was made, not when the row changed.
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: 100,
      })
    )
  })

  it("ignores decisions whose packet only mentions the document elsewhere", async () => {
    decisionRecordFindMany.mockResolvedValue([
      record("source", JSON.stringify({ schemaVersion: "tracked-decision/v2", entity: { type: "DOC", id: "other" }, sources: [{ type: "DOC", id: docId }] })),
      record("context", JSON.stringify({ schemaVersion: "tracked-decision/v1", entity: { type: "DOC", id: "other" }, context: docId })),
      record("type", packet({ type: "SOLUTION", id: docId })),
      record("match"),
    ])
    expect(await decisions.findLatestDecidedDocDecision("workspace", docId)).toEqual(expect.objectContaining({ id: "match" }))
  })

  it("falls back to the actor's email, then to null, when no name is stored", async () => {
    decisionRecordFindMany.mockResolvedValue([record("one")])
    userFindUnique.mockResolvedValue({ name: null, email: "ada@example.com" })
    expect(await decisions.findLatestDecidedDocDecision("workspace", docId)).toEqual(expect.objectContaining({ reviewerName: "ada@example.com" }))
    userFindUnique.mockResolvedValue(null)
    expect(await decisions.findLatestDecidedDocDecision("workspace", docId)).toEqual(expect.objectContaining({ reviewerName: null }))
  })

  it("pages past a full batch of non-matching records rather than reporting none", async () => {
    decisionRecordFindMany
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => record(String(i), packet({ type: "DOC", id: "other" }))))
      .mockResolvedValueOnce([record("late")])
    expect(await decisions.findLatestDecidedDocDecision("workspace", docId)).toEqual(expect.objectContaining({ id: "late" }))
    expect(decisionRecordFindMany.mock.calls[1][0].skip).toBe(100)
  })

  it("rejects an unreadable packet and a database failure rather than reporting none", async () => {
    decisionRecordFindMany.mockResolvedValue([record("broken", "{broken")])
    await expect(decisions.findLatestDecidedDocDecision("workspace", docId)).rejects.toThrow()
    decisionRecordFindMany.mockResolvedValue([record("missing", packet(), { revision: null })])
    await expect(decisions.findLatestDecidedDocDecision("workspace", docId)).rejects.toThrow("unavailable")
    decisionRecordFindMany.mockRejectedValue(new Error("db down"))
    await expect(decisions.findLatestDecidedDocDecision("workspace", docId)).rejects.toThrow("db down")
  })
})

describe("combined document decision state", () => {
  it("skips the decided lookup entirely while a request is still open", async () => {
    reviewRequestFindMany.mockResolvedValue([{ id: "open", updatedAt: new Date("2026-09-10"), currentRevision: { title: "Ship?", packetJson: packet() } }])
    expect(await decisions.listDocDecisions("workspace", docId)).toEqual({ pending: [{ id: "open", title: "Ship?" }], latestDecided: null })
    // Pending wins in the UI, so the extra reads would be wasted.
    expect(decisionRecordFindMany).not.toHaveBeenCalled()
    expect(userFindUnique).not.toHaveBeenCalled()
  })

  it("reports the recorded decision once nothing is pending", async () => {
    decisionRecordFindMany.mockResolvedValue([record("one")])
    expect(await decisions.listDocDecisions("workspace", docId)).toEqual({
      pending: [],
      latestDecided: expect.objectContaining({ id: "one", outcome: "APPROVE" }),
    })
  })

  it("propagates a failure so the caller can distinguish it from an empty document", async () => {
    reviewRequestFindMany.mockRejectedValue(new Error("unavailable"))
    await expect(decisions.listDocDecisions("workspace", docId)).rejects.toThrow("unavailable")
  })
})
