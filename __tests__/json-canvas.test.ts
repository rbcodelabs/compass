import { describe, it, expect } from "vitest"
import {
  CANVAS_PRESET_COLORS,
  emptyCanvas,
  isValidCanvasColor,
  normalizeCanvasContent,
  parseJsonCanvas,
  serializeJsonCanvas,
  MAX_CANVAS_BYTES,
} from "@/lib/json-canvas"

const sample = {
  nodes: [
    { id: "n1", type: "text", x: 0, y: 0, width: 250, height: 60, text: "# Hello", color: "1" },
    { id: "n2", type: "file", x: 300, y: 0, width: 250, height: 60, file: "notes/a.md", subpath: "#intro" },
    { id: "n3", type: "link", x: 0, y: 200, width: 250, height: 60, url: "https://example.com", color: "#FF8800" },
    { id: "g1", type: "group", x: -50, y: -50, width: 700, height: 400, label: "Group", background: "bg.png", backgroundStyle: "cover" },
  ],
  edges: [
    { id: "e1", fromNode: "n1", toNode: "n2", fromSide: "right", toSide: "left", toEnd: "arrow", fromEnd: "none", label: "x", color: "3" },
  ],
}

describe("isValidCanvasColor", () => {
  it("accepts presets 1-6 and hex colors", () => {
    for (const preset of ["1", "2", "3", "4", "5", "6"]) expect(isValidCanvasColor(preset)).toBe(true)
    expect(isValidCanvasColor("#fff")).toBe(true)
    expect(isValidCanvasColor("#FF8800")).toBe(true)
  })
  it("rejects everything else", () => {
    for (const bad of ["0", "7", "red", "#ggg", "#12", "FF8800", "", 1, null, undefined]) {
      expect(isValidCanvasColor(bad)).toBe(false)
    }
  })
  it("exposes six preset hex values", () => {
    expect(Object.keys(CANVAS_PRESET_COLORS)).toEqual(["1", "2", "3", "4", "5", "6"])
  })
})

describe("parseJsonCanvas", () => {
  it("parses a valid canvas of all four node types", () => {
    const result = parseJsonCanvas(JSON.stringify(sample))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.canvas.nodes).toHaveLength(4)
      expect(result.canvas.edges).toHaveLength(1)
    }
  })

  it("defaults missing nodes/edges to empty arrays", () => {
    const result = parseJsonCanvas("{}")
    expect(result).toEqual({ ok: true, canvas: { nodes: [], edges: [] } })
  })

  it("rejects non-JSON and non-object roots", () => {
    for (const raw of ["not json", "[]", "42", "null", '"str"']) {
      const result = parseJsonCanvas(raw)
      expect(result.ok).toBe(false)
    }
  })

  it("rejects empty input with a clear message", () => {
    const result = parseJsonCanvas("   ")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/empty|JSON/i)
  })

  it("rejects nodes with bad type, missing id, duplicate ids, or bad geometry", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ nodes: [{ id: "a", type: "image", x: 0, y: 0, width: 1, height: 1 }] }, /type/],
      [{ nodes: [{ type: "text", x: 0, y: 0, width: 1, height: 1, text: "" }] }, /id/],
      [
        { nodes: [
          { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
          { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
        ] },
        /duplicate/i,
      ],
      [{ nodes: [{ id: "a", type: "text", x: "0", y: 0, width: 1, height: 1, text: "" }] }, /x/],
      [{ nodes: [{ id: "a", type: "text", x: 0, y: 0, width: -5, height: 1, text: "" }] }, /width/],
      [{ nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1 }] }, /text/],
      [{ nodes: [{ id: "a", type: "file", x: 0, y: 0, width: 1, height: 1 }] }, /file/],
      [{ nodes: [{ id: "a", type: "link", x: 0, y: 0, width: 1, height: 1 }] }, /url/],
      [{ nodes: [{ id: "a", type: "group", x: 0, y: 0, width: 1, height: 1, backgroundStyle: "tile" }] }, /backgroundStyle/],
      [{ nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "", color: "9" }] }, /color/],
      [{ nodes: [{ id: "a", type: "file", x: 0, y: 0, width: 1, height: 1, file: "a.md", subpath: "intro" }] }, /subpath/],
      [{ nodes: "nope" }, /nodes/],
      [{ nodes: [], edges: 3 }, /edges/],
    ]
    for (const [input, pattern] of cases) {
      const result = parseJsonCanvas(JSON.stringify(input))
      expect(result.ok, JSON.stringify(input)).toBe(false)
      if (!result.ok) expect(result.errors.join("\n")).toMatch(pattern)
    }
  })

  it("rejects edges with bad sides, ends, colors, or dangling node references", () => {
    const nodes = [
      { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
      { id: "b", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
    ]
    const base = { id: "e", fromNode: "a", toNode: "b" }
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, fromSide: "middle" }, /fromSide/],
      [{ ...base, toSide: "up" }, /toSide/],
      [{ ...base, fromEnd: "dot" }, /fromEnd/],
      [{ ...base, toEnd: "circle" }, /toEnd/],
      [{ ...base, color: "bad" }, /color/],
      [{ ...base, label: 5 }, /label/],
      [{ ...base, toNode: "zzz" }, /toNode/],
      [{ ...base, fromNode: "zzz" }, /fromNode/],
      [{ fromNode: "a", toNode: "b" }, /id/],
    ]
    for (const [edge, pattern] of cases) {
      const result = parseJsonCanvas(JSON.stringify({ nodes, edges: [edge] }))
      expect(result.ok, JSON.stringify(edge)).toBe(false)
      if (!result.ok) expect(result.errors.join("\n")).toMatch(pattern)
    }
  })

  it("accepts every valid side / end combination", () => {
    const nodes = [
      { id: "a", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
      { id: "b", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
    ]
    for (const side of ["top", "right", "bottom", "left"]) {
      for (const end of ["none", "arrow"]) {
        const result = parseJsonCanvas(
          JSON.stringify({ nodes, edges: [{ id: "e", fromNode: "a", toNode: "b", fromSide: side, toSide: side, fromEnd: end, toEnd: end }] })
        )
        expect(result.ok).toBe(true)
      }
    }
  })

  it("caps the number of reported errors", () => {
    const bad = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, type: "nope" }))
    const result = parseJsonCanvas(JSON.stringify({ nodes: bad }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.length).toBeLessThanOrEqual(21)
  })

  it("rejects oversized payloads", () => {
    const result = parseJsonCanvas("x".repeat(MAX_CANVAS_BYTES + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toMatch(/too large|size/i)
  })
})

describe("round trip", () => {
  it("preserves unknown fields at every level", () => {
    const input = {
      metadata: { version: "1.0-1.0", frontmatter: {} },
      nodes: [
        { id: "n1", type: "text", x: 1, y: 2, width: 3, height: 4, text: "t", styleAttributes: { textAlign: "center" }, future: [1, 2] },
        { id: "g", type: "group", x: 0, y: 0, width: 9, height: 9, ext: true },
      ],
      edges: [{ id: "e1", fromNode: "n1", toNode: "g", fromSide: "top", ext: { a: 1 } }],
      topLevelUnknown: "keep me",
    }
    const parsed = parseJsonCanvas(JSON.stringify(input))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const again = parseJsonCanvas(serializeJsonCanvas(parsed.canvas))
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.canvas).toEqual(input)
  })

  it("is stable: serialize(parse(serialize(x))) === serialize(x)", () => {
    const first = normalizeCanvasContent(JSON.stringify(sample))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = normalizeCanvasContent(first.content)
    expect(second.ok && second.content).toBe(first.content)
  })

  it("serializes with tab indentation like Obsidian", () => {
    expect(serializeJsonCanvas(emptyCanvas())).toBe('{\n\t"nodes": [],\n\t"edges": []\n}')
  })
})

describe("normalizeCanvasContent", () => {
  it("returns a joined, human readable error string for invalid input", () => {
    const result = normalizeCanvasContent(JSON.stringify({ nodes: [{ id: "a", type: "bad" }] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/Invalid JSON Canvas/)
  })

  it("defaults an empty string to a blank canvas", () => {
    const result = normalizeCanvasContent("")
    expect(result.ok && JSON.parse(result.content)).toEqual({ nodes: [], edges: [] })
  })
})
