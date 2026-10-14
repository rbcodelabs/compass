/**
 * Static renderer for a JSON Canvas: canvas JSON in, one self-contained HTML
 * document out, ready for `captureScreenshot({ html })` (lib/capture-screenshot.ts).
 *
 * Why this exists: the live canvas editor needs a signed-in browser session, and
 * there is no session-less render route. Rendering from the canvas JSON
 * means the sandbox browser needs no auth and no network — the document carries
 * everything, and capture mode aborts every request anyway.
 *
 * Pure module: no DB, no React, no I/O. Compass card data is passed in already
 * resolved (lib/canvas-card-data.ts), so this file cannot widen what a caller
 * is allowed to see.
 *
 * Untrusted input: every string from the canvas or from card data goes through
 * `esc` before it reaches markup, and colors only pass through
 * `resolveCanvasColor`, which accepts presets and strict hex. No script is
 * emitted, and there are no URLs the browser could fetch.
 */
import { decodeCanvasCard, canvasCardKey, CANVAS_CARD_KIND_LABELS } from "@/lib/canvas-cards"
import type { CanvasCardView } from "@/lib/canvas-card-data"
import { resolveCanvasColor, type CanvasSide, type JsonCanvas, type JsonCanvasEdge, type JsonCanvasNode } from "@/lib/json-canvas"

export type CanvasBox = { x: number; y: number; width: number; height: number }

/** What part of the canvas to show, in canvas coordinates. */
export type CanvasView =
  | { kind: "overview" }
  | { kind: "region"; x: number; y: number; width: number; height: number }
  | { kind: "focus"; nodeId: string; padding?: number }

export type CanvasViewResult = { ok: true; box: CanvasBox } | { ok: false; error: string }

/** Longest output side, in pixels. Keeps the PNG (and the MCP payload) bounded. */
export const MAX_OUTPUT_SIDE = 2400
/** Default longest output side when no scale is given. */
export const DEFAULT_OUTPUT_SIDE = 1600
export const MIN_SCALE = 0.05
export const MAX_SCALE = 4
const MIN_BOX = { width: 240, height: 160 }
const MAX_REGION_SIDE = 100_000
const DEFAULT_FOCUS_PADDING = 80
const OVERVIEW_PADDING = 40
const MAX_TEXT_CHARS = 1_500
const MAX_CARD_FACTS = 4

const esc = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

const num = (n: number) => Math.round(n * 100) / 100

const nodeBox = (n: JsonCanvasNode): CanvasBox => ({ x: n.x, y: n.y, width: n.width, height: n.height })

function union(boxes: CanvasBox[]): CanvasBox | null {
  if (!boxes.length) return null
  const x1 = Math.min(...boxes.map((b) => b.x))
  const y1 = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.width))
  const y2 = Math.max(...boxes.map((b) => b.y + b.height))
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function pad(box: CanvasBox, by: number): CanvasBox {
  return { x: box.x - by, y: box.y - by, width: box.width + by * 2, height: box.height + by * 2 }
}

/** Grow a box about its centre until it reaches the minimum size, so tiny targets still get context. */
function atLeast(box: CanvasBox): CanvasBox {
  const width = Math.max(box.width, MIN_BOX.width)
  const height = Math.max(box.height, MIN_BOX.height)
  return { x: box.x - (width - box.width) / 2, y: box.y - (height - box.height) / 2, width, height }
}

const intersects = (a: CanvasBox, b: CanvasBox) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

/** Turn a requested view into the canvas-space rectangle to render. */
export function resolveCanvasView(canvas: JsonCanvas, view: CanvasView): CanvasViewResult {
  if (view.kind === "overview") {
    const all = union(canvas.nodes.map(nodeBox))
    if (!all) return { ok: false, error: "This canvas has no nodes to render." }
    return { ok: true, box: atLeast(pad(all, OVERVIEW_PADDING)) }
  }

  if (view.kind === "region") {
    const values = [view.x, view.y, view.width, view.height]
    if (!values.every(Number.isFinite)) return { ok: false, error: "Region x, y, width and height must be finite numbers." }
    if (view.width <= 0 || view.height <= 0) return { ok: false, error: "Region width and height must be greater than zero." }
    if (view.width > MAX_REGION_SIDE || view.height > MAX_REGION_SIDE) {
      return { ok: false, error: `Region is too large; each side must be at most ${MAX_REGION_SIDE} canvas units.` }
    }
    return { ok: true, box: { x: view.x, y: view.y, width: view.width, height: view.height } }
  }

  const node = canvas.nodes.find((n) => n.id === view.nodeId)
  if (!node) {
    const sample = canvas.nodes.slice(0, 8).map((n) => n.id).join(", ")
    return { ok: false, error: `No node "${view.nodeId}" on this canvas.${sample ? ` Some node ids: ${sample}.` : ""}` }
  }
  const padding = Number.isFinite(view.padding) ? Math.max(0, Math.min(view.padding!, 5_000)) : DEFAULT_FOCUS_PADDING
  return { ok: true, box: atLeast(pad(nodeBox(node), padding)) }
}

/**
 * Output pixel size and scale for a canvas-space box. An explicit `scale` is
 * honoured but clamped so neither side exceeds MAX_OUTPUT_SIDE; otherwise the box
 * is fitted so its longest side lands on DEFAULT_OUTPUT_SIDE (never magnified
 * past 2x — a tiny focus region should not become a blurry poster).
 */
export function fitOutput(box: CanvasBox, scale?: number): { scale: number; width: number; height: number } {
  const longest = Math.max(box.width, box.height)
  let s = scale !== undefined && Number.isFinite(scale) ? Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE) : Math.min(2, DEFAULT_OUTPUT_SIDE / longest)
  if (longest * s > MAX_OUTPUT_SIDE) s = MAX_OUTPUT_SIDE / longest
  return { scale: s, width: Math.max(1, Math.round(box.width * s)), height: Math.max(1, Math.round(box.height * s)) }
}

// ── edges ────────────────────────────────────────────────────────────────────

type Pt = { x: number; y: number }
const DIR: Record<CanvasSide, Pt> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } }

function anchor(n: JsonCanvasNode, side: CanvasSide): Pt {
  switch (side) {
    case "top": return { x: n.x + n.width / 2, y: n.y }
    case "bottom": return { x: n.x + n.width / 2, y: n.y + n.height }
    case "left": return { x: n.x, y: n.y + n.height / 2 }
    case "right": return { x: n.x + n.width, y: n.y + n.height / 2 }
  }
}

/** Sides to use when the edge names none: leave along the dominant axis between the two centres. */
function defaultSides(from: JsonCanvasNode, to: JsonCanvasNode): [CanvasSide, CanvasSide] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2)
  const dy = to.y + to.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"]
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"]
}

function arrowHead(tip: Pt, side: CanvasSide): string {
  // The edge arrives travelling opposite to the side's outward direction.
  const d = { x: -DIR[side].x, y: -DIR[side].y }
  const base = { x: tip.x - d.x * 16, y: tip.y - d.y * 16 }
  const n = { x: -d.y, y: d.x }
  return `${num(tip.x)},${num(tip.y)} ${num(base.x + n.x * 8)},${num(base.y + n.y * 8)} ${num(base.x - n.x * 8)},${num(base.y - n.y * 8)}`
}

function renderEdge(edge: JsonCanvasEdge, byId: Map<string, JsonCanvasNode>): string {
  const from = byId.get(edge.fromNode)
  const to = byId.get(edge.toNode)
  if (!from || !to) return ""
  const [defFrom, defTo] = defaultSides(from, to)
  const fromSide = edge.fromSide ?? defFrom
  const toSide = edge.toSide ?? defTo
  const p0 = anchor(from, fromSide)
  const p3 = anchor(to, toSide)
  const reach = Math.min(200, Math.max(40, Math.hypot(p3.x - p0.x, p3.y - p0.y) / 2))
  const p1 = { x: p0.x + DIR[fromSide].x * reach, y: p0.y + DIR[fromSide].y * reach }
  const p2 = { x: p3.x + DIR[toSide].x * reach, y: p3.y + DIR[toSide].y * reach }
  const color = resolveCanvasColor(edge.color) ?? "#6b7280"
  const toArrow = (edge.toEnd ?? "arrow") === "arrow"
  const fromArrow = edge.fromEnd === "arrow"

  let out = `<path d="M${num(p0.x)},${num(p0.y)} C${num(p1.x)},${num(p1.y)} ${num(p2.x)},${num(p2.y)} ${num(p3.x)},${num(p3.y)}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`
  if (toArrow) out += `<polygon points="${arrowHead(p3, toSide)}" fill="${color}"/>`
  if (fromArrow) out += `<polygon points="${arrowHead(p0, fromSide)}" fill="${color}"/>`
  if (typeof edge.label === "string" && edge.label.trim()) {
    const mid = { x: 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x, y: 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y }
    out += `<text x="${num(mid.x)}" y="${num(mid.y)}" text-anchor="middle" dominant-baseline="central" class="edge-label">${esc(edge.label.slice(0, 200))}</text>`
  }
  return out
}

// ── nodes ────────────────────────────────────────────────────────────────────

const clip = (text: string) => (text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text)

function nodeStyle(node: JsonCanvasNode, extra = ""): string {
  const color = resolveCanvasColor(node.color)
  const tint = color ? `--c:${color};` : ""
  return `left:${num(node.x)}px;top:${num(node.y)}px;width:${num(node.width)}px;height:${num(node.height)}px;${tint}${extra}`
}

function renderCard(node: JsonCanvasNode, cards: Record<string, CanvasCardView>): string | null {
  const ref = decodeCanvasCard(node)
  if (!ref) return null
  const kindLabel = CANVAS_CARD_KIND_LABELS[ref.kind]
  const view = cards[canvasCardKey({ kind: ref.kind, id: ref.id.toLowerCase() })]
  if (!view || view.state === "unavailable") {
    return `<div class="node card unavailable" style="${nodeStyle(node)}"><div class="kind">${esc(kindLabel)}</div><div class="title">${esc(ref.title ?? "Unavailable")}</div><div class="fact">Unavailable or not in this workspace</div></div>`
  }
  const facts = view.facts.slice(0, MAX_CARD_FACTS).map((f) => `<div class="fact"><span>${esc(f.label)}</span> ${esc(f.value)}</div>`).join("")
  const status = view.status ? `<span class="status">${esc(view.status)}</span>` : ""
  return `<div class="node card" style="${nodeStyle(node)}"><div class="kind">${esc(kindLabel)}${status}</div><div class="title">${esc(view.title)}</div>${facts}</div>`
}

function renderNode(node: JsonCanvasNode, cards: Record<string, CanvasCardView>): string {
  switch (node.type) {
    case "text":
      return `<div class="node text" style="${nodeStyle(node)}"><div class="body">${esc(clip(node.text ?? ""))}</div></div>`
    case "file":
      return `<div class="node file" style="${nodeStyle(node)}"><div class="kind">File</div><div class="title">${esc(node.file ?? "")}${node.subpath ? esc(node.subpath) : ""}</div></div>`
    case "link":
      return (
        renderCard(node, cards) ??
        `<div class="node link" style="${nodeStyle(node)}"><div class="kind">Link</div><div class="title">${esc(node.url ?? "")}</div></div>`
      )
    case "group":
      return ""
  }
}

function renderGroup(node: JsonCanvasNode): string {
  const label = typeof node.label === "string" && node.label ? `<div class="group-label">${esc(node.label)}</div>` : ""
  return `<div class="node group" style="${nodeStyle(node)}">${label}</div>`
}

export type RenderedCanvas = {
  html: string
  box: CanvasBox
  viewport: { width: number; height: number }
  scale: number
  counts: { nodes: number; edges: number; cards: number; unavailableCards: number }
}

/**
 * Build the HTML document for `box`. Only what intersects the box is emitted:
 * nodes that overlap it, and edges with an endpoint node that does. The world
 * layer is positioned in canvas coordinates and shifted/scaled into the viewport
 * with a single transform, so node geometry stays exact.
 */
export function renderCanvasHtml(canvas: JsonCanvas, box: CanvasBox, cards: Record<string, CanvasCardView>, options: { scale?: number } = {}): RenderedCanvas {
  const out = fitOutput(box, options.scale)
  const byId = new Map(canvas.nodes.map((n) => [n.id, n]))
  const visible = canvas.nodes.filter((n) => intersects(nodeBox(n), box))
  const visibleIds = new Set(visible.map((n) => n.id))
  const edges = canvas.edges.filter((e) => visibleIds.has(e.fromNode) || visibleIds.has(e.toNode))

  const groups = visible.filter((n) => n.type === "group").map(renderGroup).join("")
  const edgeSvg = edges.map((e) => renderEdge(e, byId)).join("")
  const nodes = visible.filter((n) => n.type !== "group").map((n) => renderNode(n, cards)).join("")

  let cardCount = 0
  let unavailableCards = 0
  for (const n of visible) {
    const ref = decodeCanvasCard(n)
    if (!ref) continue
    cardCount++
    const view = cards[canvasCardKey({ kind: ref.kind, id: ref.id.toLowerCase() })]
    if (!view || view.state === "unavailable") unavailableCards++
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Canvas</title><style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;width:${out.width}px;height:${out.height}px;overflow:hidden;background:#f8f9fb;font-family:system-ui,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2937}
#world{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0;transform:scale(${num(out.scale)}) translate(${num(-box.x)}px,${num(-box.y)}px)}
.node{position:absolute;overflow:hidden;border:2px solid var(--c,#9ca3af);border-radius:10px;background:#fff;padding:12px 14px;font-size:16px;line-height:1.4}
.node.group{overflow:visible;background:color-mix(in srgb,var(--c,#9ca3af) 8%,transparent);border-style:dashed;border-radius:14px;padding:0}
.group-label{position:absolute;top:0;left:12px;transform:translateY(-100%);font-size:16px;font-weight:600;background:var(--c,#6b7280);color:#fff;padding:2px 10px;border-radius:8px 8px 0 0;max-width:90%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.node.text,.node.file,.node.link,.node.card{background:color-mix(in srgb,var(--c,#ffffff) 14%,#ffffff)}
.body{white-space:pre-wrap;overflow-wrap:anywhere}
.kind{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#6b7280;display:flex;gap:8px;align-items:center}
.status{font-size:11px;background:#e5e7eb;color:#374151;border-radius:999px;padding:1px 8px;text-transform:none;letter-spacing:0}
.title{font-weight:600;margin-top:4px;overflow-wrap:anywhere}
.fact{font-size:13px;color:#4b5563;margin-top:3px}
.fact span{color:#9ca3af}
.node.unavailable{border-style:dashed;background:#f3f4f6;color:#6b7280}
#edges{position:absolute;left:0;top:0;overflow:visible;width:1px;height:1px}
.edge-label{font-size:15px;fill:#111827;stroke:#f8f9fb;stroke-width:6px;paint-order:stroke}
</style></head><body><div id="world">${groups}<svg id="edges" xmlns="http://www.w3.org/2000/svg">${edgeSvg}</svg>${nodes}</div></body></html>`

  return {
    html,
    box,
    viewport: { width: out.width, height: out.height },
    scale: out.scale,
    counts: { nodes: visible.length, edges: edges.length, cards: cardCount, unavailableCards },
  }
}
