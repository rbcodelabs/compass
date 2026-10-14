/**
 * Unit tests for the sandbox reconciliation planner (ADR 0019 §2.4) -- the
 * genuinely hard, previously-unsolved part of this design. Pure, no I/O:
 * exercises every row of the spec's baseline/final outcome table plus the
 * identity-validation and duplicate-id tie-break rules.
 */
import { describe, expect, it, vi, beforeEach } from "vitest"

const mocks = vi.hoisted(() => ({
  writeDocById: vi.fn(),
  moveDocById: vi.fn(),
  deleteDocById: vi.fn(),
  createPath: vi.fn(),
  resolvePath: vi.fn(),
  recordConflictingSnapshot: vi.fn(),
  deriveOperationId: vi.fn((base: string, salt: string) => `${base}::${salt}`),
}))
vi.mock("@/lib/doc-fs", () => mocks)

import {
  planReconciliation,
  applyReconciliationPlan,
  guardDeletes,
  reconcileAgentDocs,
  describeConflict,
  type DocBaselineEntry,
  type DocFinalFile,
  type ReconciliationAction,
} from "@/lib/agent-doc-reconciliation"
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

describe("planReconciliation ordering", () => {
  it("applies moves (parents first) before deletes, and deletes before creates", () => {
    const plan = planReconciliation(
      baseline([
        { path: "A", docId: "a", content: "a", revision: "ra" },
        { path: "A/Child", docId: "c", content: "c", revision: "rc" },
        { path: "Gone", docId: "g", content: "g", revision: "rg" },
      ]),
      final([
        { path: "B/Deep/Child", content: "c", frontmatterDocId: "c" },
        { path: "B", content: "a", frontmatterDocId: "a" },
        { path: "Fresh", content: "n", frontmatterDocId: null },
      ])
    )
    expect(plan.map((p) => p.type)).toEqual(["move", "move", "delete", "create"])
    expect(plan.filter((p) => p.type === "move").map((p) => (p.type === "move" ? p.toPath : ""))).toEqual(["B", "B/Deep/Child"])
  })
})

describe("guardDeletes (fail-closed hard deletes)", () => {
  const del = (path: string): ReconciliationAction => ({ type: "delete", path, docId: `id-${path}`, expectedRevision: "r" })

  it("keeps a delete only when the agent explicitly removed that doc", () => {
    const { plan, skipped } = guardDeletes([del("A"), del("B")], 5, { deletedPaths: ["A"] })
    expect(plan.map((p) => (p.type === "delete" ? p.path : null))).toEqual(["A"])
    expect(skipped).toEqual([{ path: "B", reason: "not-requested" }])
  })

  it("skips every delete when the sandbox view was incomplete, even explicit ones", () => {
    const { plan, skipped } = guardDeletes([del("A")], 5, { incomplete: true, deletedPaths: ["A"] })
    expect(plan).toEqual([])
    expect(skipped).toEqual([{ path: "A", reason: "incomplete" }])
  })

  it("leaves non-delete actions untouched", () => {
    const update: ReconciliationAction = { type: "update", path: "U", docId: "u", content: "x", expectedRevision: "r" }
    expect(guardDeletes([update, del("A")], 5, {}).plan).toEqual([update])
  })

  it("refuses an implausibly large explicit purge (over the cap AND over half the baseline)", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `Doc ${i}`)
    const { plan, skipped } = guardDeletes(paths.map(del), 20, { deletedPaths: paths })
    expect(plan).toEqual([])
    expect(skipped).toHaveLength(12)
    expect(new Set(skipped.map((s) => s.reason))).toEqual(new Set(["too-many"]))
  })

  it("allows the same count when it is a small share of a large workspace", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `Doc ${i}`)
    expect(guardDeletes(paths.map(del), 200, { deletedPaths: paths }).plan).toHaveLength(12)
  })
})

describe("applyReconciliationPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeDocById.mockResolvedValue({ docId: "d", revision: "r2" })
    mocks.moveDocById.mockResolvedValue({ docId: "d", revision: "r-moved" })
    mocks.deleteDocById.mockResolvedValue(undefined)
    mocks.createPath.mockResolvedValue({ docId: "n", created: true, revision: "r", path: "p" })
    mocks.recordConflictingSnapshot.mockResolvedValue(undefined)
  })

  it("addresses existing docs by id, never by baseline path, and deletes non-recursively", async () => {
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
    expect(mocks.writeDocById).toHaveBeenCalledWith("ws-1", "doc-a", "new", expect.objectContaining({ expectedRevision: "rev-a" }))
    expect(mocks.moveDocById).toHaveBeenCalledWith("ws-1", "doc-b", "B2", expect.objectContaining({ expectedRevision: "rev-b" }))
    const deleteOptions = mocks.deleteDocById.mock.calls[0][2]
    expect(mocks.deleteDocById).toHaveBeenCalledWith("ws-1", "doc-c", expect.objectContaining({ expectedRevision: "rev-c" }))
    expect(deleteOptions).not.toHaveProperty("recursive")
    expect(mocks.createPath).toHaveBeenCalledWith("ws-1", "D", "content", expect.anything())
    expect(result.applied).toHaveLength(5)
    expect(result.conflicts).toEqual([])
  })

  it("moveAndUpdate moves by id, then pins the revision the move produced for the content write", async () => {
    await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [{ type: "moveAndUpdate", fromPath: "Old", toPath: "New", docId: "doc-a", content: "new content", expectedRevision: "rev-a" }],
      "Compass Agent"
    )
    expect(mocks.moveDocById).toHaveBeenCalledWith("ws-1", "doc-a", "New", expect.objectContaining({ expectedRevision: "rev-a" }))
    expect(mocks.writeDocById).toHaveBeenCalledWith("ws-1", "doc-a", "new content", expect.objectContaining({ expectedRevision: "r-moved" }))
  })

  it("still resolves a child after its parent was renamed earlier in the same pass (no path lookup)", async () => {
    await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [
        { type: "move", fromPath: "A", toPath: "B", docId: "parent", expectedRevision: "r1" },
        { type: "update", path: "A/Child", docId: "child", content: "edited", expectedRevision: "r2" },
      ],
      "Compass Agent"
    )
    expect(mocks.writeDocById).toHaveBeenCalledWith("ws-1", "child", "edited", expect.anything())
    expect(mocks.resolvePath).not.toHaveBeenCalled()
  })

  it("on a revision conflict snapshots the would-be content, reports it, and CONTINUES with later actions", async () => {
    mocks.writeDocById.mockRejectedValueOnce(new DocumentError("revision-conflict"))
    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [
        { type: "update", path: "A", docId: "doc-a", content: "agent's version", expectedRevision: "stale-rev" },
        { type: "update", path: "B", docId: "doc-b", content: "fine", expectedRevision: "rev-b" },
      ],
      "Compass Agent"
    )
    expect(mocks.recordConflictingSnapshot).toHaveBeenCalledWith("doc-a", "agent's version", "Compass Agent")
    expect(result.conflicts).toEqual([{ path: "A", title: "A", reason: "revision" }])
    expect(result.applied).toEqual([expect.objectContaining({ docId: "doc-b" })])
  })

  it("reports a parent delete that still has children as a conflict, not an exception, and leaves content alone", async () => {
    mocks.deleteDocById.mockRejectedValueOnce(Object.assign(new Error("has children"), { name: "DocFsError", code: "has-children" }))
    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [{ type: "delete", path: "Parent", docId: "p", expectedRevision: "r" }],
      "Compass Agent"
    )
    expect(result.conflicts).toEqual([{ path: "Parent", title: "Parent", reason: "has-children" }])
    expect(mocks.recordConflictingSnapshot).not.toHaveBeenCalled()
  })

  it("a refused child delete is not overridden by its parent's delete", async () => {
    mocks.deleteDocById.mockImplementation(async (_ws: string, docId: string) => {
      if (docId === "child") throw new DocumentError("revision-conflict")
      throw Object.assign(new Error("has children"), { name: "DocFsError", code: "has-children" })
    })
    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [
        { type: "delete", path: "P/C", docId: "child", expectedRevision: "r1" },
        { type: "delete", path: "P", docId: "parent", expectedRevision: "r2" },
      ],
      "Compass Agent"
    )
    expect(result.applied).toEqual([])
    expect(result.conflicts.map((c) => c.reason)).toEqual(["revision", "has-children"])
    for (const call of mocks.deleteDocById.mock.calls) expect(call[2]).not.toHaveProperty("recursive")
  })

  it("maps operation-conflict to a conflict too, and keeps going", async () => {
    mocks.moveDocById.mockRejectedValueOnce(new DocumentError("operation-conflict"))
    const result = await applyReconciliationPlan(
      "ws-1",
      "turn-1",
      [
        { type: "move", fromPath: "A", toPath: "A2", docId: "a", expectedRevision: "r" },
        { type: "create", path: "Z", content: "z" },
      ],
      "Compass Agent"
    )
    expect(result.conflicts).toEqual([{ path: "A2", title: "A2", reason: "operation" }])
    expect(mocks.createPath).toHaveBeenCalled()
  })

  it("refuses to overwrite a doc already at a created path: conflict plus a version on the existing doc", async () => {
    mocks.createPath.mockRejectedValueOnce(Object.assign(new Error("exists"), { name: "DocFsError", code: "exists" }))
    mocks.resolvePath.mockResolvedValue({ docId: "someone-elses" })
    const result = await applyReconciliationPlan("ws-1", "turn-1", [{ type: "create", path: "Taken", content: "agent text" }], "Compass Agent")
    expect(result.conflicts).toEqual([{ path: "Taken", title: "Taken", reason: "exists" }])
    expect(mocks.recordConflictingSnapshot).toHaveBeenCalledWith("someone-elses", "agent text", "Compass Agent")
  })

  it("treats a delete of a doc that is already gone as done, so repeating a pass is harmless", async () => {
    mocks.deleteDocById.mockRejectedValueOnce(new DocumentError("not-found"))
    const result = await applyReconciliationPlan("ws-1", "turn-1", [{ type: "delete", path: "A", docId: "a", expectedRevision: "r" }], "Compass Agent")
    expect(result.conflicts).toEqual([])
    expect(result.applied).toHaveLength(1)
  })

  it("never deletes or moves when no revision can be pinned (fail closed)", async () => {
    const result = await applyReconciliationPlan("ws-1", "turn-1", [{ type: "delete", path: "A", docId: "a", expectedRevision: null }], "Compass Agent")
    expect(mocks.deleteDocById).not.toHaveBeenCalled()
    expect(result.conflicts).toEqual([{ path: "A", title: "A", reason: "revision" }])
  })

  it("re-throws anything that is not a doc-level failure", async () => {
    mocks.writeDocById.mockRejectedValue(new Error("boom"))
    await expect(
      applyReconciliationPlan("ws-1", "turn-1", [{ type: "update", path: "A", docId: "doc-a", content: "x", expectedRevision: "r" }], "Agent")
    ).rejects.toThrow("boom")
  })
})

describe("reconcileAgentDocs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.writeDocById.mockResolvedValue({ docId: "d", revision: "r2" })
    mocks.deleteDocById.mockResolvedValue(undefined)
    mocks.createPath.mockResolvedValue({ docId: "n", created: true, revision: "r", path: "p" })
  })
  const base = [
    { path: "Keep", docId: "k", revision: "rk", content: "k" },
    { path: "Lost", docId: "l", revision: "rl", content: "l" },
    { path: "Removed", docId: "x", revision: "rx", content: "x" },
  ]

  it("deletes only what the agent removed; a merely-missing doc is left alone and the user is told", async () => {
    const outcome = await reconcileAgentDocs(
      "ws-1",
      "run-1",
      base,
      { files: [{ path: "Keep", content: "k", frontmatterDocId: "k" }], incomplete: false, deletedPaths: ["Removed"] },
      "Compass Agent"
    )
    expect(mocks.deleteDocById).toHaveBeenCalledTimes(1)
    expect(mocks.deleteDocById).toHaveBeenCalledWith("ws-1", "x", expect.anything())
    expect(outcome.notices.join(" ")).toContain("'Lost'")
  })

  it("applies no delete at all from an incomplete sandbox view, and says so", async () => {
    const outcome = await reconcileAgentDocs("ws-1", "run-1", base, { files: [], incomplete: true, deletedPaths: ["Removed"] }, "Compass Agent")
    expect(mocks.deleteDocById).not.toHaveBeenCalled()
    expect(outcome.notices.join(" ")).toContain("incomplete")
  })
})

describe("describeConflict", () => {
  it("has a distinct, actionable sentence per reason", () => {
    const reasons = ["revision", "operation", "has-children", "exists", "gone", "invalid"] as const
    const sentences = reasons.map((reason) => describeConflict({ path: "A/B", title: "B", reason }))
    expect(new Set(sentences).size).toBeGreaterThanOrEqual(5)
    expect(sentences.every((s) => s.includes("'B'"))).toBe(true)
  })
})
