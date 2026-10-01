/**
 * JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) types, validation and
 * normalization. Pure — no React, no DB — so the doc layer (UI server actions,
 * MCP handlers) and the editor share one definition of "a valid canvas".
 *
 * Interoperability rule: every field this module does not understand is carried
 * through untouched (nodes, edges and the top-level object all allow extra
 * keys). A canvas authored in Obsidian/Geode, edited in Compass and exported
 * again must not lose data it never knew about.
 */

export type CanvasSide = "top" | "right" | "bottom" | "left"
export type CanvasEnd = "none" | "arrow"
export type CanvasNodeType = "text" | "file" | "link" | "group"
export type CanvasBackgroundStyle = "cover" | "ratio" | "repeat"

export const CANVAS_SIDES: readonly CanvasSide[] = ["top", "right", "bottom", "left"]
export const CANVAS_ENDS: readonly CanvasEnd[] = ["none", "arrow"]
export const CANVAS_NODE_TYPES: readonly CanvasNodeType[] = ["text", "file", "link", "group"]
const BACKGROUND_STYLES: readonly CanvasBackgroundStyle[] = ["cover", "ratio", "repeat"]

/** Preset colors "1".."6" (red, orange, yellow, green, cyan, purple). The spec leaves exact values to the app. */
export const CANVAS_PRESET_COLORS = {
  "1": "#fb464c",
  "2": "#e9973f",
  "3": "#e0de71",
  "4": "#44cf6e",
  "5": "#53dfdd",
  "6": "#a882ff",
} as const
export type CanvasPresetColor = keyof typeof CANVAS_PRESET_COLORS

/**
 * Maximum accepted serialized canvas size (characters). Kept comfortably under
 * Next's default 1 MB Server Action body limit, since the editor autosaves
 * through a Server Action and escaping/multibyte text inflates the payload.
 */
export const MAX_CANVAS_BYTES = 800_000
const MAX_REPORTED_ERRORS = 20

type Extra = { [key: string]: unknown }

export type JsonCanvasNode = Extra & {
  id: string
  type: CanvasNodeType
  x: number
  y: number
  width: number
  height: number
  color?: string
  // text
  text?: string
  // file
  file?: string
  subpath?: string
  // link
  url?: string
  // group
  label?: string
  background?: string
  backgroundStyle?: CanvasBackgroundStyle
}

export type JsonCanvasEdge = Extra & {
  id: string
  fromNode: string
  toNode: string
  fromSide?: CanvasSide
  toSide?: CanvasSide
  fromEnd?: CanvasEnd
  toEnd?: CanvasEnd
  color?: string
  label?: string
}

export type JsonCanvas = Extra & {
  nodes: JsonCanvasNode[]
  edges: JsonCanvasEdge[]
}

export type CanvasParseResult = { ok: true; canvas: JsonCanvas } | { ok: false; errors: string[] }
export type CanvasNormalizeResult = { ok: true; content: string; canvas: JsonCanvas } | { ok: false; error: string }

export function emptyCanvas(): JsonCanvas {
  return { nodes: [], edges: [] }
}

/** Presets "1".."6" or a hex color (#RGB, #RGBA, #RRGGBB, #RRGGBBAA). */
export function isValidCanvasColor(value: unknown): value is string {
  if (typeof value !== "string") return false
  if (value in CANVAS_PRESET_COLORS) return true
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
}

/** Resolve a canvas color (preset or hex) to a CSS color, or undefined when unset/invalid. */
export function resolveCanvasColor(value: unknown): string | undefined {
  if (!isValidCanvasColor(value)) return undefined
  return value in CANVAS_PRESET_COLORS ? CANVAS_PRESET_COLORS[value as CanvasPresetColor] : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateNode(raw: unknown, index: number, errors: string[], seen: Set<string>): void {
  const where = `nodes[${index}]`
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`)
    return
  }
  if (typeof raw.id !== "string" || raw.id === "") {
    errors.push(`${where}.id must be a non-empty string`)
  } else if (seen.has(raw.id)) {
    errors.push(`${where}.id "${raw.id}" is a duplicate node id`)
  } else {
    seen.add(raw.id)
  }
  if (!CANVAS_NODE_TYPES.includes(raw.type as CanvasNodeType)) {
    errors.push(`${where}.type must be one of ${CANVAS_NODE_TYPES.join(", ")}`)
    return
  }
  for (const key of ["x", "y"] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key])) errors.push(`${where}.${key} must be a finite number`)
  }
  for (const key of ["width", "height"] as const) {
    const value = raw[key]
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) errors.push(`${where}.${key} must be a non-negative number`)
  }
  if (raw.color !== undefined && !isValidCanvasColor(raw.color)) {
    errors.push(`${where}.color must be a preset "1"-"6" or a hex color like "#FF8800"`)
  }
  switch (raw.type) {
    case "text":
      if (typeof raw.text !== "string") errors.push(`${where}.text must be a string for text nodes`)
      break
    case "file":
      if (typeof raw.file !== "string" || raw.file === "") errors.push(`${where}.file must be a non-empty string for file nodes`)
      if (raw.subpath !== undefined && (typeof raw.subpath !== "string" || !raw.subpath.startsWith("#"))) {
        errors.push(`${where}.subpath must be a string starting with "#"`)
      }
      break
    case "link":
      if (typeof raw.url !== "string") errors.push(`${where}.url must be a string for link nodes`)
      break
    case "group":
      if (raw.label !== undefined && typeof raw.label !== "string") errors.push(`${where}.label must be a string`)
      if (raw.background !== undefined && typeof raw.background !== "string") errors.push(`${where}.background must be a string`)
      if (raw.backgroundStyle !== undefined && !BACKGROUND_STYLES.includes(raw.backgroundStyle as CanvasBackgroundStyle)) {
        errors.push(`${where}.backgroundStyle must be one of ${BACKGROUND_STYLES.join(", ")}`)
      }
      break
  }
}

function validateEdge(raw: unknown, index: number, errors: string[], nodeIds: Set<string>, seen: Set<string>): void {
  const where = `edges[${index}]`
  if (!isRecord(raw)) {
    errors.push(`${where} must be an object`)
    return
  }
  if (typeof raw.id !== "string" || raw.id === "") {
    errors.push(`${where}.id must be a non-empty string`)
  } else if (seen.has(raw.id)) {
    errors.push(`${where}.id "${raw.id}" is a duplicate edge id`)
  } else {
    seen.add(raw.id)
  }
  for (const key of ["fromNode", "toNode"] as const) {
    const value = raw[key]
    if (typeof value !== "string" || value === "") errors.push(`${where}.${key} must be a node id`)
    else if (!nodeIds.has(value)) errors.push(`${where}.${key} references unknown node "${value}"`)
  }
  for (const key of ["fromSide", "toSide"] as const) {
    if (raw[key] !== undefined && !CANVAS_SIDES.includes(raw[key] as CanvasSide)) {
      errors.push(`${where}.${key} must be one of ${CANVAS_SIDES.join(", ")}`)
    }
  }
  for (const key of ["fromEnd", "toEnd"] as const) {
    if (raw[key] !== undefined && !CANVAS_ENDS.includes(raw[key] as CanvasEnd)) {
      errors.push(`${where}.${key} must be one of ${CANVAS_ENDS.join(", ")}`)
    }
  }
  if (raw.color !== undefined && !isValidCanvasColor(raw.color)) {
    errors.push(`${where}.color must be a preset "1"-"6" or a hex color like "#FF8800"`)
  }
  if (raw.label !== undefined && typeof raw.label !== "string") errors.push(`${where}.label must be a string`)
}

/**
 * Parse and validate a JSON Canvas document. Accepts the raw string or an
 * already-parsed value. Unknown fields are preserved on the returned canvas.
 */
export function parseJsonCanvas(input: unknown): CanvasParseResult {
  let value: unknown = input
  if (typeof input === "string") {
    if (input.trim() === "") return { ok: false, errors: ["Canvas content is empty; expected a JSON object like {\"nodes\":[],\"edges\":[]}"] }
    if (input.length > MAX_CANVAS_BYTES) {
      return { ok: false, errors: [`Canvas is too large (limit ${Math.round(MAX_CANVAS_BYTES / 1000)} KB)`] }
    }
    try {
      value = JSON.parse(input)
    } catch (error) {
      return { ok: false, errors: [`Canvas is not valid JSON: ${error instanceof Error ? error.message : "parse error"}`] }
    }
  }
  if (!isRecord(value)) return { ok: false, errors: ["Canvas must be a JSON object with optional \"nodes\" and \"edges\" arrays"] }

  const errors: string[] = []
  const nodesRaw = value.nodes ?? []
  const edgesRaw = value.edges ?? []
  if (!Array.isArray(nodesRaw)) errors.push("\"nodes\" must be an array")
  if (!Array.isArray(edgesRaw)) errors.push("\"edges\" must be an array")
  if (errors.length) return { ok: false, errors }

  const nodeIds = new Set<string>()
  ;(nodesRaw as unknown[]).forEach((node, index) => validateNode(node, index, errors, nodeIds))
  const edgeIds = new Set<string>()
  ;(edgesRaw as unknown[]).forEach((edge, index) => validateEdge(edge, index, errors, nodeIds, edgeIds))

  if (errors.length) {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS)
    if (errors.length > MAX_REPORTED_ERRORS) shown.push(`...and ${errors.length - MAX_REPORTED_ERRORS} more problems`)
    return { ok: false, errors: shown }
  }
  return { ok: true, canvas: { ...value, nodes: nodesRaw as JsonCanvasNode[], edges: edgesRaw as JsonCanvasEdge[] } }
}

/** Tab-indented like Obsidian writes .canvas files, so diffs stay quiet. */
export function serializeJsonCanvas(canvas: JsonCanvas): string {
  return JSON.stringify(canvas, null, "\t")
}

/**
 * Validate canvas content for storage and return the canonical string.
 * An empty/whitespace body is treated as a blank canvas (a freshly created doc).
 */
export function normalizeCanvasContent(raw: string): CanvasNormalizeResult {
  if (raw.trim() === "") {
    const canvas = emptyCanvas()
    return { ok: true, content: serializeJsonCanvas(canvas), canvas }
  }
  const parsed = parseJsonCanvas(raw)
  if (!parsed.ok) return { ok: false, error: `Invalid JSON Canvas: ${parsed.errors.join("; ")}` }
  return { ok: true, content: serializeJsonCanvas(parsed.canvas), canvas: parsed.canvas }
}
