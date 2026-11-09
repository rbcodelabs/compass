/**
 * Pure before -> after diff of two JSON values, flattened to leaf rows so the approval page can show exactly what changes.
 * Nothing here renders HTML; values come out as plain text and React escapes them. No imports at runtime, so client components
 * may use it (packet.ts pulls in node:crypto, hence the type-only import).
 */
import type { Json } from "@/lib/tool-approval/packet"

export type DiffKind = "added" | "removed" | "changed" | "unchanged"

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
const MAX_CHANGED_ROWS = 400
const MAX_UNCHANGED_ROWS = 100
const ROOT = "(value)"

const isObject = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === "object" && !Array.isArray(value)
const isScalar = (value: Json): boolean => value === null || typeof value !== "object"
const isEmptyContainer = (value: Json): boolean => (Array.isArray(value) ? value.length === 0 : isObject(value) && Object.keys(value).length === 0)

/** Text for one leaf: strings quoted JSON-style (so "" and "null" are distinguishable), everything else compact JSON. */
export function formatValue(value: Json): string {
  const text = JSON.stringify(value) ?? "null"
  return text.length > MAX_DISPLAY_VALUE_CHARS ? `${text.slice(0, MAX_DISPLAY_VALUE_CHARS)}… (${text.length - MAX_DISPLAY_VALUE_CHARS} more characters)` : text
}

const isLeaf = (value: Json): boolean => isScalar(value) || isEmptyContainer(value)
const keyPath = (parent: string, key: string): string => {
  const part = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : JSON.stringify(key)
  return parent ? (part.startsWith('"') ? `${parent}[${part}]` : `${parent}.${part}`) : part
}
const indexPath = (parent: string, index: number): string => `${parent || ROOT}[${index}]`

function collect(value: Json, path: string, kind: "added" | "removed", out: DiffRow[]): void {
  if (isLeaf(value)) {
    out.push(kind === "added" ? { path: path || ROOT, kind, after: formatValue(value) } : { path: path || ROOT, kind, before: formatValue(value) })
    return
  }
  if (Array.isArray(value)) value.forEach((item, index) => collect(item, indexPath(path, index), kind, out))
  else for (const key of Object.keys(value).sort()) collect((value as { [key: string]: Json })[key], keyPath(path, key), kind, out)
}

function walk(before: Json, after: Json, path: string, out: DiffRow[]): void {
  if (isLeaf(before) && isLeaf(after)) {
    const left = formatValue(before)
    const right = formatValue(after)
    out.push(left === right ? { path: path || ROOT, kind: "unchanged", before: left, after: right } : { path: path || ROOT, kind: "changed", before: left, after: right })
    return
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    // A list of plain values reads as membership (what was added, what was removed), not as a shifted index-by-index rewrite.
    if (before.every(isLeaf) && after.every(isLeaf)) {
      const beforeKeys = before.map(formatValue)
      const afterKeys = after.map(formatValue)
      const remaining = [...afterKeys]
      for (const key of beforeKeys) {
        const at = remaining.indexOf(key)
        if (at >= 0) { remaining.splice(at, 1); out.push({ path: `${path || ROOT}[]`, kind: "unchanged", before: key, after: key }) }
        else out.push({ path: `${path || ROOT}[]`, kind: "removed", before: key })
      }
      for (const key of remaining) out.push({ path: `${path || ROOT}[]`, kind: "added", after: key })
      return
    }
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      if (i >= before.length) collect(after[i], indexPath(path, i), "added", out)
      else if (i >= after.length) collect(before[i], indexPath(path, i), "removed", out)
      else walk(before[i], after[i], indexPath(path, i), out)
    }
    return
  }
  if (isObject(before) && isObject(after)) {
    for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const child = keyPath(path, key)
      if (!(key in after)) collect(before[key], child, "removed", out)
      else if (!(key in before)) collect(after[key], child, "added", out)
      else walk(before[key], after[key], child, out)
    }
    return
  }
  // The shape itself changed (an object became text, a list became an object): show the whole value on each side.
  out.push({ path: path || ROOT, kind: "changed", before: formatValue(before), after: formatValue(after) })
}

export type EffectDiff = {
  changed: DiffRow[]
  unchanged: DiffRow[]
  /** Rows beyond the display caps, counted so the page can say the diff was cut instead of implying it was complete. */
  omittedChanges: number
  omittedUnchanged: number
}

/** The changes a call would make, ordered by path, plus the untouched context. Each list is capped; the overflow is counted. */
export function diffJson(before: Json, after: Json): EffectDiff {
  const all: DiffRow[] = []
  walk(before, after, "", all)
  const changed = all.filter((row) => row.kind !== "unchanged")
  const unchanged = all.filter((row) => row.kind === "unchanged")
  return {
    changed: changed.slice(0, MAX_CHANGED_ROWS), unchanged: unchanged.slice(0, MAX_UNCHANGED_ROWS),
    omittedChanges: Math.max(0, changed.length - MAX_CHANGED_ROWS), omittedUnchanged: Math.max(0, unchanged.length - MAX_UNCHANGED_ROWS),
  }
}
