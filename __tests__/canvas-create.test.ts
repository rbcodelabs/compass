import { describe, expect, it } from "vitest"
import {
  childCenterBelow,
  creatableKinds,
  isCanvasCreateKind,
  normalizeCreateTitle,
  parentEdge,
  parentFor,
} from "@/lib/canvas-create"

describe("creatableKinds", () => {
  it("offers only parentless kinds with no usable selection", () => {
    expect(creatableKinds(undefined)).toEqual(["opportunity", "task"])
    expect(creatableKinds("doc")).toEqual(["opportunity", "task"])
  })
  it("offers solutions under a selected opportunity and assumptions under a selected solution", () => {
    expect(creatableKinds("opportunity")).toEqual(["opportunity", "solution", "task"])
    expect(creatableKinds("solution")).toEqual(["opportunity", "task", "assumption"])
  })
  it("never offers experiments", () => {
    expect(isCanvasCreateKind("experiment")).toBe(false)
  })
})

describe("parentFor", () => {
  it("links only kinds that nest under the selected kind", () => {
    expect(parentFor("solution", "opportunity")).toBe(true)
    expect(parentFor("assumption", "solution")).toBe(true)
    expect(parentFor("task", "opportunity")).toBe(false)
    expect(parentFor("solution", "solution")).toBe(false)
    expect(parentFor("solution", undefined)).toBe(false)
  })
})

describe("normalizeCreateTitle", () => {
  it("trims, and rejects blank, non-string and over-long titles", () => {
    expect(normalizeCreateTitle("  Hi  ")).toEqual({ ok: true, title: "Hi" })
    expect(normalizeCreateTitle("   ").ok).toBe(false)
    expect(normalizeCreateTitle(5).ok).toBe(false)
    expect(normalizeCreateTitle("x".repeat(256)).ok).toBe(false)
    expect(normalizeCreateTitle("x".repeat(255)).ok).toBe(true)
  })
})

describe("canvas placement", () => {
  it("draws parent -> child with automatic sides", () => {
    expect(parentEdge("e1", "p", "c")).toEqual({ id: "e1", fromNode: "p", toNode: "c" })
  })
  it("centers the child below the parent", () => {
    expect(childCenterBelow({ x: 0, y: 0, width: 280, height: 120 }, { width: 280, height: 120 })).toEqual({ x: 140, y: 260 })
  })
})
