import { describe, expect, it } from "vitest"
import { diffCanvas, isCanvasDiffEmpty } from "@/lib/json-canvas-diff"
import { describeRemoteWriter, isTypingNow } from "@/lib/doc-remote-update"
import type { JsonCanvas } from "@/lib/json-canvas"

const node = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "text" as const, text: id, x: 0, y: 0, width: 100, height: 50, ...over })

describe("diffCanvas", () => {
  const prev: JsonCanvas = { nodes: [node("a"), node("b"), node("c")], edges: [{ id: "e1", fromNode: "a", toNode: "b" }, { id: "e2", fromNode: "b", toNode: "c" }] }

  it("reports nothing for an identical canvas, even if z-order differs", () => {
    expect(isCanvasDiffEmpty(diffCanvas(prev, { ...prev, nodes: [...prev.nodes].reverse() }))).toBe(true)
  })

  it("splits added, removed, moved and content-changed by id", () => {
    const next: JsonCanvas = {
      nodes: [node("a", { x: 300 }), node("b", { text: "renamed" }), node("d")],
      edges: [{ id: "e1", fromNode: "a", toNode: "b" }, { id: "e3", fromNode: "a", toNode: "d" }],
    }
    expect(diffCanvas(prev, next)).toEqual({
      addedNodes: ["d"], removedNodes: ["c"], movedNodes: ["a"], changedNodes: ["b"],
      addedEdges: ["e3"], removedEdges: ["e2"], changedEdges: [],
    })
  })
})

describe("describeRemoteWriter", () => {
  it("names the user, noting a non-UI write path", () => {
    expect(describeRemoteWriter({ name: "Ada", source: "UI" })).toBe("Ada")
    expect(describeRemoteWriter({ name: "Ada", source: "MCP" })).toBe("Ada (via MCP)")
  })
  it("falls back to 'an agent' for a non-UI write and 'someone' otherwise", () => {
    expect(describeRemoteWriter({ name: null, source: "MCP" })).toBe("an agent")
    expect(describeRemoteWriter({ name: null, source: "UI" })).toBe("someone")
    expect(describeRemoteWriter(undefined)).toBe("someone")
  })
})

describe("isTypingNow", () => {
  it("is true only when focused and the last keystroke was recent", () => {
    expect(isTypingNow(true, 1_000, 2_000)).toBe(true)
    expect(isTypingNow(true, 1_000, 10_000)).toBe(false)
    expect(isTypingNow(false, 1_000, 2_000)).toBe(false)
  })
})
