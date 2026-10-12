import { describe, it, expect } from "vitest"
import {
  CANVAS_CARD_KINDS,
  canvasCardKey,
  canvasCardUrl,
  createCanvasCardNode,
  decodeCanvasCard,
  encodeCanvasCardFields,
  parseCanvasCardUrl,
  sanitizeCanvasCards,
} from "@/lib/canvas-cards"
import { normalizeCanvasContent, parseJsonCanvas, serializeJsonCanvas } from "@/lib/json-canvas"
import { fromFlow, toFlow } from "@/lib/json-canvas-flow"

const ID = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f"

const linkNode = (extra: Record<string, unknown> = {}) => ({
  id: "n1", type: "link", x: 0, y: 0, width: 260, height: 110, url: `compass://opportunity/${ID}`, ...extra,
})
const canvasOf = (...nodes: unknown[]) => JSON.stringify({ nodes, edges: [] })

describe("kinds, urls and encoding", () => {
  it("allowlists exactly the supported kinds", () => {
    expect([...CANVAS_CARD_KINDS].sort()).toEqual(
      ["assumption", "doc", "experiment", "keyResult", "metric", "objective", "opportunity", "roadmapItem", "solution", "task"]
    )
  })

  it("builds and parses compass:// urls", () => {
    expect(canvasCardUrl({ kind: "metric", id: ID })).toBe(`compass://metric/${ID}`)
    expect(parseCanvasCardUrl(`compass://metric/${ID}`)).toEqual({ kind: "metric", id: ID })
    for (const bad of ["compass://nope/" + ID, "compass://metric/not-a-uuid", "https://x.com", `compass://metric/${ID}/extra`, ""]) {
      expect(parseCanvasCardUrl(bad)).toBeNull()
    }
  })

  it("encodes a plain JSON Canvas link node with a namespaced compass field", () => {
    const node = createCanvasCardNode("abc", { kind: "solution", id: ID }, "My solution", { x: 1.4, y: 2.6 })
    expect(node).toMatchObject({ id: "abc", type: "link", x: 1, y: 3, url: `compass://solution/${ID}`, compass: { kind: "solution", id: ID, title: "My solution" } })
    expect(parseJsonCanvas(JSON.stringify({ nodes: [node], edges: [] })).ok).toBe(true)
    expect(encodeCanvasCardFields({ kind: "doc", id: ID })).toEqual({ url: `compass://doc/${ID}`, compass: { kind: "doc", id: ID } })
  })

  it("keys refs by kind and id", () => {
    expect(canvasCardKey({ kind: "task", id: ID })).toBe(`task:${ID}`)
  })
})

describe("decodeCanvasCard", () => {
  it("decodes from the compass field, with title", () => {
    expect(decodeCanvasCard(linkNode({ compass: { kind: "experiment", id: ID, title: "T" } }) as never)).toEqual({ kind: "experiment", id: ID, title: "T" })
  })
  it("falls back to the compass:// url when another tool dropped the field", () => {
    expect(decodeCanvasCard(linkNode() as never)).toEqual({ kind: "opportunity", id: ID })
  })
  it("returns null for plain links, other node types, and invalid refs", () => {
    expect(decodeCanvasCard(linkNode({ url: "https://example.com" }) as never)).toBeNull()
    expect(decodeCanvasCard({ ...linkNode({ compass: { kind: "doc", id: ID } }), type: "text", text: "" } as never)).toBeNull()
    expect(decodeCanvasCard(linkNode({ url: "https://e.com", compass: { kind: "bogus", id: ID } }) as never)).toBeNull()
    expect(decodeCanvasCard(linkNode({ url: "https://e.com", compass: { kind: "doc", id: "nope" } }) as never)).toBeNull()
  })
})

describe("validation on write", () => {
  it("strict mode (MCP) rejects unknown kinds, bad ids, non-objects and non-link nodes", () => {
    const cases: unknown[] = [
      linkNode({ compass: { kind: "bogus", id: ID } }),
      linkNode({ compass: { kind: "doc", id: "nope" } }),
      linkNode({ compass: "doc" }),
      linkNode({ compass: { kind: "doc", id: ID, title: 5 } }),
      { id: "t", type: "text", x: 0, y: 0, width: 1, height: 1, text: "", compass: { kind: "doc", id: ID } },
    ]
    for (const node of cases) {
      const result = normalizeCanvasContent(canvasOf(node), { strictCards: true })
      expect(result.ok, JSON.stringify(node)).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/compass/)
    }
  })

  it("strict mode accepts valid cards", () => {
    const result = normalizeCanvasContent(canvasOf(linkNode({ compass: { kind: "metric", id: ID, title: "MRR" } })), { strictCards: true })
    expect(result.ok).toBe(true)
  })

  it("default mode (UI / imports) degrades invalid refs to plain link cards instead of failing", () => {
    const result = normalizeCanvasContent(canvasOf(linkNode({ url: "https://example.com", compass: { kind: "bogus", id: ID }, extra: 1 })))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const node = result.canvas.nodes[0]
    expect(node.compass).toBeUndefined()
    expect(node).toMatchObject({ type: "link", url: "https://example.com", extra: 1 })
    expect(decodeCanvasCard(node)).toBeNull()
  })

  it("sanitizeCanvasCards trims over-long cached titles", () => {
    const { canvas } = sanitizeCanvasCards(
      { nodes: [linkNode({ compass: { kind: "doc", id: ID, title: "x".repeat(400) } })] as never, edges: [] },
      { strict: false }
    )
    expect((canvas.nodes[0].compass as { title: string }).title).toHaveLength(255)
  })
})

describe("interop round trip", () => {
  it("preserves the compass field through parse -> flow -> export", () => {
    const input = { metadata: { a: 1 }, nodes: [linkNode({ compass: { kind: "task", id: ID, title: "Ship" } })], edges: [] }
    const parsed = parseJsonCanvas(JSON.stringify(input))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const flow = toFlow(parsed.canvas)
    const out = fromFlow(parsed.canvas, flow.nodes, flow.edges)
    expect(out).toEqual(input)
    const normalized = normalizeCanvasContent(serializeJsonCanvas(out), { strictCards: true })
    expect(normalized.ok && JSON.parse(normalized.content)).toEqual(input)
  })

  it("exports stay valid JSON Canvas 1.0 (standard link node with a url)", () => {
    const node = createCanvasCardNode("n", { kind: "doc", id: ID }, undefined, { x: 0, y: 0 })
    const parsed = parseJsonCanvas(serializeJsonCanvas({ nodes: [node], edges: [] }))
    expect(parsed.ok).toBe(true)
    expect(node.type).toBe("link")
    expect(typeof node.url).toBe("string")
  })
})
