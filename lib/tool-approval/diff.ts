/**
 * Pure before -> after diff of two JSON values, flattened to leaf rows so the approval page can show exactly what changes.
 * Nothing here renders HTML; values come out as plain text and React escapes them. No imports at runtime, so client components
 * may use it (packet.ts pulls in node:crypto, hence the type-only import).
 *
 * The packet is stored data an agent influenced, so every walk is bounded: depth, total nodes, and the size of any one printed
 * value. Hitting a bound yields an explicit "truncated" row; it never throws and never silently drops the rest.
 */
import type { Json } from "@/lib/tool-approval/packet"

export type DiffKind = "added" | "removed" | "changed" | "unchanged" | "truncated"

export type DiffRow = {
  /** `a.b[0].c`; "(value)" for a root scalar; a trailing `[]` marks a member added to / removed from a list of plain values. */
  path: string
  kind: DiffKind
  /** Present for removed, changed and unchanged rows. */
  before?: string
  /** Present for added, changed and unchanged rows. */
  after?: string
}

/** One displayed value never exceeds this many characters; the rest is summarised, not dropped silently. */
export const MAX_DISPLAY_VALUE_CHARS = 2000
/** Nesting deeper than this is not walked; the subtree becomes one truncated row. */
export const MAX_DIFF_DEPTH = 12
/** Total values visited in one diff; past this the walk stops with one truncated row. */
export const MAX_DIFF_NODES = 2000
/** How many changes the compact chat card shows before sending the reader to the full page. */
export const COMPACT_ROW_LIMIT = 4
/** The chat card shows the call arguments only up to this size. */
export const CARD_ARGS_CHARS = 4000
const MAX_CHANGED_ROWS = 400
const MAX_UNCHANGED_ROWS = 100
const ROOT = "(value)"
const FORMAT_DEPTH = 6

const isObject = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === "object" && !Array.isArray(value)
const isScalar = (value: Json): boolean => value === null || typeof value !== "object"
const isEmptyContainer = (value: Json): boolean => (Array.isArray(value) ? value.length === 0 : isObject(value) && Object.keys(value).length === 0)
const isLeaf = (value: Json): boolean => isScalar(value) || isEmptyContainer(value)
const has = (record: object, key: string): boolean => Object.hasOwn(record, key)

/** JSON-like text for a container with a depth and character budget: bounded work, no recursion past FORMAT_DEPTH. */
function bounded(value: Json, state: { left: number }, depth: number): string {
  if (state.left <= 0) return "…"
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value) ?? "null"
    const cut = text.slice(0, Math.max(0, state.left))
    state.left -= cut.length
    return cut
  }
  if (depth <= 0) { state.left -= 3; return Array.isArray(value) ? "[…]" : "{…}" }
  const parts: string[] = []
  state.left -= 2
  if (Array.isArray(value)) {
    for (const item of value) {
      if (state.left <= 0) { parts.push("…"); break }
      parts.push(bounded(item, state, depth - 1))
      state.left -= 1
    }
    return `[${parts.join(",")}]`
  }
  for (const key of Object.keys(value)) {
    if (state.left <= 0) { parts.push("…"); break }
    const name = JSON.stringify(key)
    state.left -= name.length + 1
    parts.push(`${name}:${bounded(value[key], state, depth - 1)}`)
  }
  return `{${parts.join(",")}}`
}

/** Text for one leaf: strings quoted JSON-style (so "" and "null" are distinguishable), everything else compact JSON. */
export function formatValue(value: Json): string {
  if (value !== null && typeof value === "object" && !isEmptyContainer(value)) {
    const state = { left: MAX_DISPLAY_VALUE_CHARS }
    const text = bounded(value, state, FORMAT_DEPTH)
    return state.left <= 0 ? `${text} (cut)` : text
  }
  const text = JSON.stringify(value) ?? "null"
  return text.length > MAX_DISPLAY_VALUE_CHARS ? `${text.slice(0, MAX_DISPLAY_VALUE_CHARS)}… (${text.length - MAX_DISPLAY_VALUE_CHARS} more characters)` : text
}

/** `JSON.stringify` that cannot throw on absurd nesting and never returns more than `maxChars`; says whether it cut. */
export function previewJson(value: Json, maxChars: number, options: { pretty?: boolean } = {}): { text: string; truncated: boolean } {
  let text: string
  try {
    text = JSON.stringify(value, null, options.pretty ? 2 : 0) ?? "null"
  } catch {
    const state = { left: maxChars }
    return { text: `${bounded(value, state, FORMAT_DEPTH)}`, truncated: true }
  }
  return text.length > maxChars ? { text: `${text.slice(0, maxChars)}…`, truncated: true } : { text, truncated: false }
}

const keyPath = (parent: string, key: string): string => {
  const part = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key)
  return parent ? (part.startsWith('"') ? `${parent}[${part}]` : `${parent}.${part}`) : part
}
const indexPath = (parent: string, index: number): string => `${parent || ROOT}[${index}]`

type Walk = { rows: DiffRow[]; nodes: number; exceeded: boolean }

/** Spends one node; false once the budget is gone (the caller stops descending). */
function spend(walk: Walk, count = 1): boolean {
  if (walk.exceeded) return false
  walk.nodes += count
  if (walk.nodes > MAX_DIFF_NODES) { walk.exceeded = true; return false }
  return true
}

function cut(walk: Walk, path: string): void {
  walk.rows.push({ path: path || ROOT, kind: "truncated" })
}

function collect(value: Json, path: string, kind: "added" | "removed", depth: number, walk: Walk): void {
  if (!spend(walk)) return
  if (depth > MAX_DIFF_DEPTH) { cut(walk, path); return }
  if (isLeaf(value)) {
    walk.rows.push(kind === "added" ? { path: path || ROOT, kind, after: formatValue(value) } : { path: path || ROOT, kind, before: formatValue(value) })
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && !walk.exceeded; index += 1) collect(value[index], indexPath(path, index), kind, depth + 1, walk)
    return
  }
  // isLeaf already took null and scalars, so this is a non-empty object.
  const record = value as { [key: string]: Json }
  for (const key of Object.keys(record).sort()) {
    if (walk.exceeded) return
    collect(record[key], keyPath(path, key), kind, depth + 1, walk)
  }
}

function membership(before: Json[], after: Json[], path: string, walk: Walk): void {
  if (!spend(walk, before.length + after.length)) return
  const remaining = new Map<string, number>()
  for (const item of after) { const key = formatValue(item); remaining.set(key, (remaining.get(key) ?? 0) + 1) }
  const label = `${path || ROOT}[]`
  for (const item of before) {
    const key = formatValue(item)
    const left = remaining.get(key) ?? 0
    if (left > 0) { remaining.set(key, left - 1); walk.rows.push({ path: label, kind: "unchanged", before: key, after: key }) }
    else walk.rows.push({ path: label, kind: "removed", before: key })
  }
  for (const [key, count] of remaining) for (let i = 0; i < count; i += 1) walk.rows.push({ path: label, kind: "added", after: key })
}

function visit(before: Json, after: Json, path: string, depth: number, walk: Walk): void {
  if (!spend(walk)) return
  if (depth > MAX_DIFF_DEPTH) { cut(walk, path); return }
  if (isLeaf(before) && isLeaf(after)) {
    const left = formatValue(before)
    const right = formatValue(after)
    walk.rows.push(left === right ? { path: path || ROOT, kind: "unchanged", before: left, after: right } : { path: path || ROOT, kind: "changed", before: left, after: right })
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    // A list of plain values reads as membership (what was added, what was removed), not as a shifted index-by-index rewrite.
    if (before.every(isLeaf) && after.every(isLeaf)) { membership(before, after, path, walk); return }
    for (let i = 0; i < Math.max(before.length, after.length) && !walk.exceeded; i += 1) {
      if (i >= before.length) collect(after[i], indexPath(path, i), "added", depth + 1, walk)
      else if (i >= after.length) collect(before[i], indexPath(path, i), "removed", depth + 1, walk)
      else visit(before[i], after[i], indexPath(path, i), depth + 1, walk)
    }
    return
  }
  if (isObject(before) && isObject(after)) {
    // Own keys only: a plain `key in obj` also finds constructor, toString and friends on the prototype chain.
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (walk.exceeded) return
      const child = keyPath(path, key)
      if (!has(after, key)) collect(before[key], child, "removed", depth + 1, walk)
      else if (!has(before, key)) collect(after[key], child, "added", depth + 1, walk)
      else visit(before[key], after[key], child, depth + 1, walk)
    }
    return
  }
  // The shape itself changed (an object became text, a list became an object): show the whole value on each side.
  walk.rows.push({ path: path || ROOT, kind: "changed", before: formatValue(before), after: formatValue(after) })
}

export type EffectDiff = {
  changed: DiffRow[]
  unchanged: DiffRow[]
  /** Rows beyond the display caps, counted so the page can say the diff was cut instead of implying it was complete. */
  omittedChanges: number
  omittedUnchanged: number
  /** True when a depth/size bound or a display cap cut the diff: what is shown is not everything that changes. */
  incomplete: boolean
}

/** The changes a call would make, ordered by path, plus the untouched context. Every bound is explicit; nothing here throws. */
export function diffJson(before: Json, after: Json): EffectDiff {
  const walk: Walk = { rows: [], nodes: 0, exceeded: false }
  visit(before, after, "", 0, walk)
  if (walk.exceeded) walk.rows.push({ path: "(rest)", kind: "truncated" })
  const real = walk.rows.filter((row) => row.kind !== "unchanged" && row.kind !== "truncated")
  const cuts = walk.rows.filter((row) => row.kind === "truncated")
  const unchanged = walk.rows.filter((row) => row.kind === "unchanged")
  const omittedChanges = Math.max(0, real.length - MAX_CHANGED_ROWS)
  return {
    // The truncated markers are kept even when the real rows hit their cap: the reader must always be told the diff is partial.
    changed: [...real.slice(0, MAX_CHANGED_ROWS), ...cuts.slice(0, 5)], unchanged: unchanged.slice(0, MAX_UNCHANGED_ROWS),
    omittedChanges, omittedUnchanged: Math.max(0, unchanged.length - MAX_UNCHANGED_ROWS),
    incomplete: omittedChanges > 0 || cuts.length > 0,
  }
}

/**
 * Whether the compact chat card shows everything a person needs before approving: every change, and the arguments. When it
 * does not, the card keeps Approve disabled and sends the person to the full page.
 */
export function reviewableInCard(before: Json, after: Json, args: Json): { ok: true } | { ok: false; reason: string } {
  const diff = diffJson(before, after)
  if (diff.incomplete || diff.changed.length > COMPACT_ROW_LIMIT) return { ok: false, reason: "Not all changes are shown here." }
  if (previewJson(args, CARD_ARGS_CHARS).truncated) return { ok: false, reason: "The call arguments are too long to show here." }
  return { ok: true }
}
