/**
 * Unit tests for the sandbox reconciliation planner (ADR 0019 §2.4) -- the
 * genuinely hard, previously-unsolved part of this design. Pure, no I/O:
 * exercises every row of the spec's baseline/final outcome table plus the
 * identity-validation and duplicate-id tie-break rules.
 */
import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  writePath: vi.fn(),
  movePath: vi.fn(),
  deletePath: vi.fn(),
  recordConflictingSnapshot: vi.fn(),
  deriveOperationId: vi.fn((base: string, salt: string) => `${base}::${salt}`),
}))
vi.mock("@/lib/doc-fs", () => mocks)

import { planReconciliation, applyReconciliationPlan, type DocBaselineEntry, type DocFinalFile } from "@/lib/agent-doc-reconciliation"
import { DocumentError } from "@/lib/document-service"

function baseline(entries: Partial<DocBaselineEntry>[]): DocBaselineEntry[] {
  return entries.map((e) => ({ path: "path", docId: "doc", revision: "rev", content: "content", ...e }))
}
function final(entries: Partial<DocFinalFile>[]): DocFinalFile[] {
  return entries.map((e) => ({ path: "path", content: "content", frontmatterDocId: null, ...e }))
}

describe("planReconciliation", () => {
  it("no-op: same docId, same path, same content", () => {
    const plan = planReconciliation(
      baseline([{ path: "Vision", docId: "doc-1", content: "hello" }]),
      final([{ path: "Vision", content: "hello", frontmatterDocId: "doc-1" }])
    )
    expect(plan).toEqual([{ type: "noop", path: "Vision", docId: "doc-1" }])
  })

  it("update: same docId, same path, different content", () => {
    const plan = planReconciliation(
      baseline([{ path: "Vision", docId: "doc-1", content: "old", revision: "rev-1" }]),
      final([{ path: "Vision", content: "new", frontmatterDocId: "doc-1" }])
    )
    expect(plan).toEqual([{ type: "update", path: "Vision", docId: "doc-1", content: "new", expectedRevision: "rev-1" }])
  })

  it("move: same docId, different path, same content", () => {
    const plan = planReconciliation(
      baseline([{ path: "Old Name", docId: "doc-1", content: "hello", revision: "rev-1" }]),
      final([{ path: "New Name", content: "hello", frontmatterDocId: "doc-1" }])
    )
    expect(plan).toEqual([{ type: "move", fromPath: "Old Name", toPath: "New Name", docId: "doc-1", expectedRevision: "rev-1" }])
  })

  it("moveAndUpdate: same docId, different path, different content", () => {
    const plan = planReconciliation(
      baseline([{ path: "Old Name", docId: "doc-1", content: "old", revision: "rev-1" }]),
      final([{ path: "New Name", content: "new", frontmatterDocId: "doc-1" }])
    )
    expect(plan).toEqual([
      { type: "moveAndUpdate", fromPath: "Old Name", toPath: "New Name", docId: "doc-1", content: "new", expectedRevision: "rev-1" },
    ])
  })

  it("delete: docId gone from the final tree entirely", () => {
    const plan = planReconciliation(baseline([{ path: "Vision", docId: "doc-1", revision: "rev-1" }]), final([]))
    expect(plan).toEqual([{ type: "delete", path: "Vision", docId: "doc-1", expectedRevision: "rev-1" }])
  })

  it("create: new path with no valid docId", () => {
    const plan = planReconciliation([], final([{ path: "New Doc", content: "hi", frontmatterDocId: null }]))
    expect(plan).toEqual([{ type: "create", path: "New Doc", content: "hi" }])
  })

  it("treats a missing/malformed/foreign frontmatterDocId as 'no id' (a create), never as identity", () => {
    const plan = planReconciliation(
      baseline([{ path: "Real Doc", docId: "doc-1" }]),
      final([{ path: "Copycat", content: "copied", frontmatterDocId: "not-a-real-baseline-id" }])
    )
    // The baseline doc is now missing from final (delete), and the foreign-id
    // file is a brand new doc (create) -- never treated as a move of doc-1.
    expect(plan).toEqual(
      expect.arrayContaining([
        { type: "delete", path: "Real Doc", docId: "doc-1", expectedRevision: "rev" },
        { type: "create", path: "Copycat", content: "copied" },
      ])
    )
    expect(plan).toHaveLength(2)
  })

  it("deepest deletes are ordered before shallower ones (bottom-up)", () => {
    const plan = planReconciliation(
      baseline([
        { path: "Product", docId: "parent" },
        { path: "Product/Roadmap", docId: "child" },
        { path: "Product/Roadmap/Q3", docId: "grandchild" },
      ]),
      final([])
    )
    expect(plan.map((a) => (a.type === "delete" ? a.path : null))).toEqual(["Product/Roadmap/Q3", "Product/Roadmap", "Product"])
  })

  it("shallower creates are ordered before deeper ones (top-down)", () => {
    const plan = planReconciliation(
      [],
      final([
        { path: "Product/Roadmap/Q3", content: "c", frontmatterDocId: null },
        { path: "Product", content: "c", frontmatterDocId: null },
        { path: "Product/Roadmap", content: "c", frontmatterDocId: null },
      ])
    )
    expect(plan.map((a) => (a.type === "create" ? a.path : null))).toEqual(["Product", "Product/Roadmap", "Product/Roadmap/Q3"])
  })

  it("duplicated id: the occurrence lexically closest to the baseline path wins as the move/update; the other becomes a create", () => {
    const plan = planReconciliation(
      baseline([{ path: "Product/Vision", docId: "doc-1", content: "original", revision: "rev-1" }]),
      final([
        { path: "Product/Vision Copy", content: "duplicated", frontmatterDocId: "doc-1" },
        { path: "Product/Vision", content: "original", frontmatterDocId: "doc-1" },
      ])
    )
    expect(plan).toEqual(
      expect.arrayContaining([
        { type: "noop", path: "Product/Vision", docId: "doc-1" },
        { type: "create", path: "Product/Vision Copy", content: "duplicated" },
      ])
    )
    expect(plan).toHaveLength(2)
  })

  it("processes multiple independent baseline docs correctly in one pass", () => {
    const plan = planReconciliation(
      baseline([
        { path: "A", docId: "doc-a", content: "a", revision: "rev-a" },
        { path: "B", docId: "doc-b", content: "b", revision: "rev-b" },
      ]),
      final([
        { path: "A", content: "a", frontmatterDocId: "doc-a" }, // noop
        { path: "B2", content: "b", frontmatterDocId: "doc-b" }, // move
        { path: "C", content: "c", frontmatterDocId: null }, // create
      ])
    )
    expect(plan).toEqual(
      expect.arrayContaining([
        { type: "noop", path: "A", docId: "doc-a" },
        { type: "move", fromPath: "B", toPath: "B2", docId: "doc-b", expectedRevision: "rev-b" },
        { type: "create", path: "C", content: "c" },
      ])
    )
    expect(plan).toHaveLength(3)
  })
})

describe("applyReconciliationPlan", () => {
  beforeEach(() => vi.clearAllMocks())

  it("applies each action type through the matching doc-fs call", async () => {
    mocks.writePath.mockResolvedValue({ docId: "d", created: false, revision: "r", path: "p" })
    mocks.movePath.mockResolvedValue({ docId: "d", revision: "r" })
    mocks.deletePath.mockResolvedValue(undefined)

    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [
        { type: "noop", path: "A", docId: "doc-a" },
        { type: "update", path: "A", docId: "doc-a", content: "new", expectedRevision: "rev-a" },
        { type: "move", fromPath: "B", toPath: "B2", docId: "doc-b", expectedRevision: "rev-b" },
        { type: "delete", path: "C", docId: "doc-c", expectedRevision: "rev-c" },
        { type: "create", path: "D", content: "content" },
      ],
      "Compass Agent"
    )

    expect(mocks.writePath).toHaveBeenCalledWith("ws-1", "A", "new", expect.objectContaining({ expectedRevision: "rev-a" }))
    expect(mocks.movePath).toHaveBeenCalledWith("ws-1", "B", "B2", expect.objectContaining({ expectedRevision: "rev-b" }))
    expect(mocks.deletePath).toHaveBeenCalledWith("ws-1", "C", expect.objectContaining({ expectedRevision: "rev-c", recursive: true }))
    expect(mocks.writePath).toHaveBeenCalledWith("ws-1", "D", "content", expect.anything())
    expect(result.applied).toHaveLength(5)
    expect(result.conflicts).toEqual([])
  })

  it("moveAndUpdate calls movePath then writePath at the new path", async () => {
    mocks.movePath.mockResolvedValue({ docId: "doc-a", revision: "r" })
    mocks.writePath.mockResolvedValue({ docId: "doc-a", created: false, revision: "r2", path: "New" })
    await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [{ type: "moveAndUpdate", fromPath: "Old", toPath: "New", docId: "doc-a", content: "new content", expectedRevision: "rev-a" }],
      "Compass Agent"
    )
    expect(mocks.movePath).toHaveBeenCalledWith("ws-1", "Old", "New", expect.objectContaining({ expectedRevision: "rev-a" }))
    expect(mocks.writePath).toHaveBeenCalledWith("ws-1", "New", "new content", expect.anything())
  })

  it("never touches the live doc on a revision conflict: snapshots the would-be content and reports it, applying nothing further for that action", async () => {
    mocks.writePath.mockRejectedValue(new DocumentError("revision-conflict"))
    mocks.recordConflictingSnapshot.mockResolvedValue(undefined)

    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [{ type: "update", path: "A", docId: "doc-a", content: "agent's version", expectedRevision: "stale-rev" }],
      "Compass Agent"
    )

    expect(mocks.recordConflictingSnapshot).toHaveBeenCalledWith("doc-a", "agent's version", "Compass Agent")
    expect(result.conflicts).toEqual([{ path: "A", title: "A" }])
    expect(result.applied).toEqual([])
  })

  it("reports a delete conflict without attempting to snapshot content (there is none)", async () => {
    mocks.deletePath.mockRejectedValue(new DocumentError("revision-conflict"))
    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [{ type: "delete", path: "A", docId: "doc-a", expectedRevision: "stale-rev" }],
      "Compass Agent"
    )
    expect(mocks.recordConflictingSnapshot).not.toHaveBeenCalled()
    expect(result.conflicts).toEqual([{ path: "A", title: "A" }])
  })

  it("re-throws any error that isn't a revision conflict", async () => {
    mocks.writePath.mockRejectedValue(new Error("boom"))
    await expect(
      applyReconciliationPlan("ws-1", "turn-1", [{ type: "update", path: "A", docId: "doc-a", content: "x", expectedRevision: "r" }], "Agent")
    ).rejects.toThrow("boom")
  })
})
