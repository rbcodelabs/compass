import { effectiveOptionValue, type SelectOptionInput } from "@/lib/shared-field-options"

/**
 * Pure list operations behind the option-list editor
 * (components/custom-fields/option-list-editor.tsx).
 *
 * Every operation returns a new list and carries an option's `value` and
 * `color` through untouched unless it is the thing being changed. That is the
 * whole point: stored CustomFieldValues reference option values, so a label
 * rename must never re-derive the value, and a reorder must never drop colour.
 * Brand-new options are appended label-only; normalizeSelectOptions derives
 * their slug when the list is saved.
 */

/** Preset swatches offered by the editor. Dark enough to carry white chip text. */
export const OPTION_COLOR_PRESETS = [
  { name: "Gray", value: "#6b7280" },
  { name: "Red", value: "#dc2626" },
  { name: "Orange", value: "#ea580c" },
  { name: "Amber", value: "#b45309" },
  { name: "Green", value: "#16a34a" },
  { name: "Teal", value: "#0d9488" },
  { name: "Blue", value: "#2563eb" },
  { name: "Violet", value: "#7c3aed" },
  { name: "Pink", value: "#db2777" },
] as const

function withoutColor(option: SelectOptionInput): SelectOptionInput {
  const next = { ...option }
  delete next.color
  return next
}

export function renameOption(
  options: readonly SelectOptionInput[],
  index: number,
  label: string
): SelectOptionInput[] {
  return options.map((option, i) => (i === index ? { ...option, label } : option))
}

export function setOptionColor(
  options: readonly SelectOptionInput[],
  index: number,
  color: string | null
): SelectOptionInput[] {
  return options.map((option, i) => {
    if (i !== index) return option
    return color ? { ...option, color } : withoutColor(option)
  })
}

export function removeOption(options: readonly SelectOptionInput[], index: number): SelectOptionInput[] {
  return options.filter((_, i) => i !== index)
}

/** Moves the option at `from` to position `to`; out-of-range targets are a no-op. */
export function moveOption(
  options: readonly SelectOptionInput[],
  from: number,
  to: number
): SelectOptionInput[] {
  if (from === to || from < 0 || to < 0 || from >= options.length || to >= options.length) {
    return [...options]
  }
  const next = [...options]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

const LIST_BULLET = /^(?:[-*•]|\d+[.)])\s+/

/**
 * Splits text typed or pasted into the "Add option" input into labels.
 *
 * Multi-line text splits on newlines only, so a pasted column of labels like
 * "Acme, Inc." survives intact; single-line text keeps the old comma-separated
 * bulk entry. Markdown/numbered list bullets and a trailing comma (a pasted
 * "Low,\nMedium,") are stripped from each line.
 */
export function splitPastedOptionLabels(raw: string): string[] {
  const parts = /[\r\n]/.test(raw) ? raw.split(/\r?\n|\r/) : raw.split(",")
  return parts
    .map((part) => part.trim().replace(LIST_BULLET, "").replace(/,+$/, "").trim())
    .filter(Boolean)
}

/** Case-insensitive identity keys: an option collides on either its label or its stored value. */
function identityKeys(option: SelectOptionInput): string[] {
  const label = (option.label ?? "").trim().toLowerCase()
  const value = effectiveOptionValue({ ...option, label: option.label.trim() }).toLowerCase()
  return [...new Set([label, value])].filter(Boolean)
}

export type AddOptionsResult = {
  options: SelectOptionInput[]
  /** Labels that were not added because an option with the same identity exists. */
  duplicates: string[]
  /** True when nothing but whitespace was submitted. */
  blank?: true
}

export function addOptionLabels(
  options: readonly SelectOptionInput[],
  labels: readonly string[]
): AddOptionsResult {
  const trimmed = labels.map((label) => label.trim()).filter(Boolean)
  if (trimmed.length === 0) return { options: [...options], duplicates: [], blank: true }

  const taken = new Set(options.flatMap(identityKeys))
  const next = [...options]
  const duplicates: string[] = []
  for (const label of trimmed) {
    const keys = identityKeys({ label })
    if (keys.some((key) => taken.has(key))) {
      duplicates.push(label)
      continue
    }
    keys.forEach((key) => taken.add(key))
    next.push({ label })
  }
  return { options: next, duplicates }
}

/**
 * Per-row validation messages (null when the row is fine). A later row that
 * collides with an earlier one is flagged, not the earlier one, so the message
 * points at the row the user most likely just edited.
 */
export function optionListIssues(options: readonly SelectOptionInput[]): (string | null)[] {
  const firstLabelByKey = new Map<string, string>()
  return options.map((option) => {
    const label = (option.label ?? "").trim()
    if (!label) return "Label can't be blank"
    const keys = identityKeys(option)
    const clash = keys.map((key) => firstLabelByKey.get(key)).find((found) => found !== undefined)
    if (clash !== undefined) return `Duplicate of “${clash}”`
    keys.forEach((key) => firstLabelByKey.set(key, label))
    return null
  })
}

export function hasOptionListIssues(options: readonly SelectOptionInput[]): boolean {
  return optionListIssues(options).some((issue) => issue !== null)
}
