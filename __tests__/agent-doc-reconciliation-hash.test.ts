/**
 * Hash-only entries in the reconciliation planner (ADR 0019 §2.4). A detached run
 * has only a signed hash manifest for its baseline, and the sandbox sends content
 * for a final file only when it differs, so the planner must decide no-op / move /
 * update from hashes and must never turn a bare hash into a write.
 */
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/doc-fs", () => ({
  writePath: vi.fn(),
  movePath: vi.fn(),
  deletePath: vi.fn(),
  recordConflictingSnapshot: vi.fn(),
  deriveOperationId: vi.fn((base: string, salt: string) => `${base}::${salt}`),
}))

import { planReconciliation } from "@/lib/agent-doc-reconciliation"

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

describe("planReconciliation with hash-only entries", () => {
  it("treats an unchanged hash-only file as a no-op without ever seeing its content", () => {
    const plan = planReconciliation(
      [{ path: "Vision", docId: "doc-1", revision: "rev-1", contentSha256: sha("hello") }],
      [{ path: "Vision", frontmatterDocId: "doc-1", contentSha256: sha("hello") }]
    )
    expect(plan).toEqual([{ type: "noop", path: "Vision", docId: "doc-1" }])
  })

  it("moves an unchanged hash-only file", () => {
    const plan = planReconciliation(
      [{ path: "Old", docId: "doc-1", revision: "rev-1", contentSha256: sha("hello") }],
      [{ path: "New", frontmatterDocId: "doc-1", contentSha256: sha("hello") }]
    )
    expect(plan).toEqual([{ type: "move", fromPath: "Old", toPath: "New", docId: "doc-1", expectedRevision: "rev-1" }])
  })

  it("updates from content against a hash-only baseline", () => {
    const plan = planReconciliation(
      [{ path: "Vision", docId: "doc-1", revision: "rev-1", contentSha256: sha("old") }],
      [{ path: "Vision", frontmatterDocId: "doc-1", content: "new" }]
    )
    expect(plan).toEqual([{ type: "update", path: "Vision", docId: "doc-1", content: "new", expectedRevision: "rev-1" }])
  })

  it("deletes a baseline doc that is absent from the final tree", () => {
    const plan = planReconciliation([{ path: "Gone", docId: "doc-1", revision: "rev-1", contentSha256: sha("x") }], [])
    expect(plan).toEqual([{ type: "delete", path: "Gone", docId: "doc-1", expectedRevision: "rev-1" }])
  })

  it("refuses to write when a changed file arrives with a hash but no content", () => {
    expect(() =>
      planReconciliation(
        [{ path: "Vision", docId: "doc-1", revision: "rev-1", contentSha256: sha("old") }],
        [{ path: "Vision", frontmatterDocId: "doc-1", contentSha256: sha("new") }]
      )
    ).toThrow(/no content was provided/)
  })

  it("refuses to create a doc from a hash alone", () => {
    expect(() => planReconciliation([], [{ path: "Fresh", frontmatterDocId: null, contentSha256: sha("x") }])).toThrow(/no content was provided/)
  })
})
