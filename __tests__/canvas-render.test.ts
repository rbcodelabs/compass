import { describe, expect, it } from "vitest"
import type { JsonCanvas } from "@/lib/json-canvas"
import type { CanvasCardView } from "@/lib/canvas-card-data"
import { fitOutput, MAX_OUTPUT_SIDE, renderCanvasHtml, resolveCanvasView } from "@/lib/canvas-render"

const OPP = "11111111-1111-4111-8111-111111111111"
const DOC = "22222222-2222-4222-8222-222222222222"

const canvas: JsonCanvas = {
  nodes: [
    { id: "g", type: "group", x: -50, y: -50, width: 700, height: 400, label: "Discovery <b>", color: "4" },
    { id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Hello <script>alert(1)</script> & co", color: "1" },
    { id: "b", type: "text", x: 400, y: 0, width: 200, height: 100, text: "Second", color: "#ff8800" },
    { id: "far", type: "text", x: 5000, y: 5000, width: 200, height: 100, text: "FAR AWAY" },
    { id: "c", type: "link", x: 0, y: 200, width: 280, height: 120, url: `compass://opportunity/${OPP}`, compass: { kind: "opportunity", id: OPP, title: "Cached" } },
    { id: "d", type: "link", x: 400, y: 200, width: 280, height: 120, url: `compass://doc/${DOC}`, compass: { kind: "doc", id: DOC, title: "Gone doc" } },
    { id: "l", type: "link", x: 400, y: 400, width: 200, height: 80, url: "https://example.com/<x>" },
  ],
  edges: [
    { id: "e1", fromNode: "a", toNode: "b", label: "leads <to>", color: "2" },
    { id: "e2", fromNode: "b", toNode: "far", toEnd: "none" },
    { id: "e3", fromNode: "far", toNode: "far" },
  ],
}

const cards: Record<string, CanvasCardView> = {
  [`opportunity:${OPP}`]: { state: "ok", kind: "opportunity", id: OPP, title: "Live <title>", status: "ACTIVE", facts: [{ label: "Score", value: "82%" }], href: "/x" },
  [`doc:${DOC}`]: { state: "unavailable", kind: "doc", id: DOC },
}

describe("resolveCanvasView", () => {
  it("overview covers every node with padding", () => {
    const r = resolveCanvasView(canvas, { kind: "overview" })
    expect(r).toMatchObject({ ok: true, box: { x: -90, y: -90 } })
    if (r.ok) {
      expect(r.box.x + r.box.width).toBeGreaterThanOrEqual(5240)
      expect(r.box.y + r.box.height).toBeGreaterThanOrEqual(5140)
    }
  })

  it("rejects an empty canvas overview", () => {
    expect(resolveCanvasView({ nodes: [], edges: [] }, { kind: "overview" })).toEqual({ ok: false, error: "This canvas has no nodes to render." })
  })

  it("focus pads the node and defaults padding to 80", () => {
    const r = resolveCanvasView(canvas, { kind: "focus", nodeId: "a" })
    expect(r).toEqual({ ok: true, box: { x: -80, y: -80, width: 360, height: 260 } })
  })

  it("focus clamps padding and grows tiny boxes to a minimum", () => {
    const tiny: JsonCanvas = { nodes: [{ id: "t", type: "text", x: 100, y: 100, width: 10, height: 10, text: "" }], edges: [] }
    const r = resolveCanvasView(tiny, { kind: "focus", nodeId: "t", padding: 0 })
    expect(r).toMatchObject({ ok: true, box: { width: 240, height: 160 } })
    const huge = resolveCanvasView(canvas, { kind: "focus", nodeId: "a", padding: 1e9 })
    expect(huge).toMatchObject({ ok: true, box: { width: 200 + 10_000 } })
  })

  it("focus on an unknown node lists some ids", () => {
    const r = resolveCanvasView(canvas, { kind: "focus", nodeId: "nope" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('No node "nope"')
    if (!r.ok) expect(r.error).toContain("a, b")
  })

  it("validates regions", () => {
    expect(resolveCanvasView(canvas, { kind: "region", x: 0, y: 0, width: 0, height: 10 }).ok).toBe(false)
    expect(resolveCanvasView(canvas, { kind: "region", x: NaN, y: 0, width: 10, height: 10 }).ok).toBe(false)
    expect(resolveCanvasView(canvas, { kind: "region", x: 0, y: 0, width: 1e6, height: 10 }).ok).toBe(false)
    expect(resolveCanvasView(canvas, { kind: "region", x: 1, y: 2, width: 3, height: 4 })).toEqual({ ok: true, box: { x: 1, y: 2, width: 3, height: 4 } })
  })
})

describe("fitOutput", () => {
  it("fits the longest side to ~1600 and never magnifies past 2x", () => {
    expect(fitOutput({ x: 0, y: 0, width: 8000, height: 4000 })).toMatchObject({ width: 1600, height: 800 })
    expect(fitOutput({ x: 0, y: 0, width: 240, height: 160 }).scale).toBe(2)
  })

  it("clamps an explicit scale so no side exceeds the cap", () => {
    const out = fitOutput({ x: 0, y: 0, width: 1000, height: 500 }, 4)
    expect(out.width).toBe(MAX_OUTPUT_SIDE)
    expect(out.height).toBe(MAX_OUTPUT_SIDE / 2)
    expect(fitOutput({ x: 0, y: 0, width: 1000, height: 500 }, 0.5)).toMatchObject({ scale: 0.5, width: 500, height: 250 })
    expect(fitOutput({ x: 0, y: 0, width: 1, height: 1 }, Number.NaN).scale).toBe(2)
  })
})

describe("renderCanvasHtml", () => {
  const box = { x: -90, y: -90, width: 860, height: 640 }
  const out = renderCanvasHtml(canvas, box, cards)

  it("escapes every untrusted string and emits no script", () => {
    expect(out.html).not.toContain("<script")
    expect(out.html).toContain("Hello &lt;script&gt;alert(1)&lt;/script&gt; &amp; co")
    expect(out.html).toContain("Discovery &lt;b&gt;")
    expect(out.html).toContain("leads &lt;to&gt;")
    expect(out.html).toContain("https://example.com/&lt;x&gt;")
    expect(out.html).toContain("Live &lt;title&gt;")
  })

  it("draws only what intersects the view", () => {
    expect(out.html).not.toContain("FAR AWAY")
    expect(out.counts.nodes).toBe(6)
    // e2 keeps one visible endpoint; e3 touches only the hidden node.
    expect(out.counts.edges).toBe(2)
  })

  it("resolves preset and hex colours and drops invalid ones", () => {
    expect(out.html).toContain("--c:#fb464c")
    expect(out.html).toContain("--c:#ff8800")
    const bad = renderCanvasHtml({ nodes: [{ id: "x", type: "text", x: 0, y: 0, width: 50, height: 50, text: "t", color: "red;background:url(x)" }], edges: [] }, box, {})
    expect(bad.html).not.toContain("url(x)")
  })

  it("renders edges with arrows and labels; toEnd none has no arrowhead", () => {
    const only = (edges: JsonCanvas["edges"]) => renderCanvasHtml({ nodes: canvas.nodes, edges }, box, cards).html.match(/<polygon/g)?.length ?? 0
    expect(only([canvas.edges[0]])).toBe(1)
    expect(only([{ id: "x", fromNode: "a", toNode: "b", toEnd: "none" }])).toBe(0)
    expect(only([{ id: "x", fromNode: "a", toNode: "b", fromEnd: "arrow" }])).toBe(2)
    expect(out.html).toContain('class="edge-label"')
  })

  it("renders live cards, unavailable cards (with cached title) and plain links", () => {
    expect(out.html).toContain("ACTIVE")
    expect(out.html).toContain("Score")
    expect(out.html).toContain("Unavailable or not in this workspace")
    expect(out.html).toContain("Gone doc")
    expect(out.counts).toMatchObject({ cards: 2, unavailableCards: 1 })
  })

  it("treats a card with no resolved view as unavailable", () => {
    const r = renderCanvasHtml(canvas, box, {})
    expect(r.counts).toMatchObject({ cards: 2, unavailableCards: 2 })
    expect(r.html).toContain("Cached")
  })

  it("sizes the viewport and world transform from the view", () => {
    expect(out.viewport.width).toBe(Math.round(box.width * out.scale))
    expect(out.html).toContain(`translate(90px,90px)`)
    expect(out.html).toContain(`width:${out.viewport.width}px;height:${out.viewport.height}px`)
  })

  it("renders nothing crashy for an empty region", () => {
    const r = renderCanvasHtml(canvas, { x: 9000, y: 9000, width: 100, height: 100 }, cards)
    expect(r.counts).toEqual({ nodes: 0, edges: 0, cards: 0, unavailableCards: 0 })
    expect(r.html).toContain("<!doctype html>")
  })
})
