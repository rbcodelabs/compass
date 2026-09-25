import type { CustomFieldType, SelectOption } from "@/lib/types"

/**
 * Shared field option sets — the workspace-level picklists that any number of
 * SELECT / MULTI_SELECT CustomFieldDefinitions (across different objectTypes)
 * can point at instead of each keeping an independent copy of the same list.
 *
 * Everything in this module is pure. The database-facing half lives in
 * app/[orgSlug]/[workspaceSlug]/settings/actions.ts and lib/custom-field-filter.ts.
 */

/** Only a picklist field can adopt a shared set; enforced in app code, not the DB. */
export const SHARED_OPTION_SET_FIELD_TYPES = ["SELECT", "MULTI_SELECT"] as const

export type SharedOptionSetFieldType = (typeof SHARED_OPTION_SET_FIELD_TYPES)[number]

export function supportsSharedOptionSet(fieldType: string): fieldType is SharedOptionSetFieldType {
  return (SHARED_OPTION_SET_FIELD_TYPES as readonly string[]).includes(fieldType)
}

/**
 * Tolerant read of a Json options column. The column is untyped at the database
 * level, and rows predate this feature, so a malformed entry must degrade to
 * "no such option" rather than throwing inside a server component render.
 */
export function parseSelectOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return []
  const options: SelectOption[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.label !== "string" || typeof candidate.value !== "string") continue
    options.push(
      typeof candidate.color === "string"
        ? { label: candidate.label, value: candidate.value, color: candidate.color }
        : { label: candidate.label, value: candidate.value }
    )
  }
  return options
}

/** Matches the slug the existing add-field form already produces from a label. */
function slugify(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, "_")
}

export type SelectOptionInput = { label: string; value?: string | null; color?: string | null }

/**
 * The value an option will be stored under: its own value when it already has
 * one (so renaming a label never changes it), otherwise the slug of its label.
 */
export function effectiveOptionValue(entry: SelectOptionInput): string {
  return (entry.value ?? "").trim() || slugify(entry.label ?? "")
}

/**
 * Canonicalizes user-entered options before they are written: trims labels,
 * derives a slug value when the caller did not supply one, drops blank labels,
 * and de-duplicates by value so one picklist can never offer the same value
 * twice. First occurrence wins, which keeps list order stable while editing.
 */
export function normalizeSelectOptions(input: readonly SelectOptionInput[]): SelectOption[] {
  const seen = new Set<string>()
  const options: SelectOption[] = []
  for (const entry of input) {
    const label = (entry?.label ?? "").trim()
    if (!label) continue
    const value = effectiveOptionValue({ ...entry, label })
    if (!value || seen.has(value)) continue
    seen.add(value)
    const color = (entry.color ?? "").trim()
    options.push(color ? { label, value, color } : { label, value })
  }
  return options
}

/**
 * The options a field actually offers: the shared set's list when attached,
 * the field's own list otherwise. Non-picklist field types have none.
 */
export function resolveEffectiveOptions(field: {
  fieldType: string
  options: unknown
  sharedOptionSet?: { options: unknown } | null
}): SelectOption[] {
  if (!supportsSharedOptionSet(field.fieldType)) return []
  return field.sharedOptionSet
    ? parseSelectOptions(field.sharedOptionSet.options)
    : parseSelectOptions(field.options)
}

/**
 * The option values a stored CustomFieldValue actually carries.
 *
 * SELECT stores a bare string and MULTI_SELECT a JSON array, so both are
 * flattened to one list the picker can treat uniformly. Non-string members are
 * dropped rather than stringified: `custom_field_values.value` is an untyped
 * Json column, a field's type can be changed after values exist, and coercing
 * `42` into the option value `"42"` would invent a selection the picklist never
 * offered. Duplicates collapse because one object cannot carry an option twice.
 */
export function toStoredOptionValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== "string" || entry === "") continue
    seen.add(entry)
  }
  return [...seen]
}

/** An option offered by the picker; `stale` marks one only a stored value proves existed. */
export type PickerOption = SelectOption & { stale?: true }

/**
 * Everything the value picker must be able to show: the field's effective
 * options, followed by a synthetic entry for each stored value none of them
 * match.
 *
 * Those synthetic entries are not cosmetic. The picker reports its whole
 * selection on every change, so a stored value absent from the list would be
 * silently dropped the next time the user touched any *other* option — the same
 * class of quiet data loss as the free-text editor this replaces. Keeping them
 * in the list is what lets a value survive until someone deliberately removes
 * it. Their label is the raw stored value, because no better one exists.
 */
export function pickerOptions(
  options: readonly SelectOption[] | null | undefined,
  stored: readonly string[]
): PickerOption[] {
  const known = options ?? []
  const offered = new Set(known.map((option) => option.value))
  const stale: PickerOption[] = []
  for (const value of stored) {
    if (offered.has(value)) continue
    offered.add(value)
    stale.push({ label: value, value, stale: true })
  }
  return [...known, ...stale]
}

/**
 * Does a stored CustomFieldValue carry `wanted`?
 *
 * MULTI_SELECT stores a JSON array of option values, SELECT stores a bare
 * string, so this is containment for the array case and exact equality for the
 * scalar case — never substring matching, and never coercion of non-string
 * members. Deliberately evaluated in application code rather than pushed into
 * a jsonb containment predicate: `custom_field_values` is only indexed on
 * field_id, so either form reads the same rows, and this one is guaranteed to
 * behave identically on local PostgreSQL and Aurora DSQL.
 */
export function customFieldValueMatches(value: unknown, wanted: string): boolean {
  if (!wanted) return false
  if (Array.isArray(value)) return value.some((entry) => typeof entry === "string" && entry === wanted)
  return typeof value === "string" && value === wanted
}

/** True when a field can be offered as a filter facet: a picklist with options. */
export function isFilterableField(field: {
  fieldType: CustomFieldType | string
  options: SelectOption[] | null
}): boolean {
  return supportsSharedOptionSet(field.fieldType) && (field.options?.length ?? 0) > 0
}
