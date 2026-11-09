/**
 * Custom field inheritance (ADR: Custom field inheritance rules, TASK-101).
 *
 * A rule says: the target field on a ROADMAP_ITEM defaults from the source field on the OPPORTUNITY or SOLUTION
 * the item is linked to. Everything here is insert-only and empty-target-only: an existing value (including an
 * explicit false or 0) is never touched, nothing is ever cleared, and there is no continuous sync.
 *
 * Two entry points, both run inside the caller's transaction (captureWorkspaceMutation for roadmap writers, the
 * value-write funnel for source values) and both reuse the same per-item logic:
 *  - applyInheritanceRules: an item was created with a link, or its link changed to a new non-null value;
 *  - applyInheritanceForSourceValue: a source field value was set later; fill empty targets on linked items.
 *
 * Every query is scoped by workspaceId, a missing rules table means "no rules" (so code and migration can ship in
 * either order), and any drift (type, options, deleted source) skips with a counted reason rather than failing
 * the user's write.
 */
import type { AppTransactionClient } from "@/lib/db"
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions"
import {
  describeRuleIncompatibility,
  SUPPORTED_INHERITANCE_PAIRS,
  type InheritanceSourceType,
  type InheritanceTargetType,
} from "@/lib/custom-field-inheritance-compat"
import { isClearingValue, validateValueForFieldType } from "@/lib/custom-field-validation"
import { customFieldInheritanceTableExists } from "@/lib/feature-tables"
import type { CustomFieldDefinitionData, CustomFieldValue } from "@/lib/types"

export type { InheritanceTargetType, InheritanceSourceType } from "@/lib/custom-field-inheritance-compat"
export { SUPPORTED_INHERITANCE_PAIRS }

export const MAX_ITEMS_PER_SOURCE_WRITE = 500

export type InheritanceLinks = { opportunityId?: string | null; solutionId?: string | null }

export type InheritedField = {
  ruleId: string
  fieldId: string
  fieldName: string
  value: CustomFieldValue
  from: { objectType: InheritanceSourceType; objectId: string; fieldId: string; fieldName: string }
}

export type InheritanceSkipReason = "type_mismatch" | "options_mismatch" | "invalid_value" | "field_missing"
export type InheritanceSkip = { ruleId: string; itemId: string; reason: InheritanceSkipReason }

export type InheritanceResult = { applied: InheritedField[]; skipped: InheritanceSkip[] }

type Item = { id: string; opportunityId: string | null; solutionId: string | null }

type RuleRow = {
  id: string
  targetFieldId: string
  sourceObjectType: string
  sourceFieldId: string
  priority: number
}

const EMPTY = (): InheritanceResult => ({ applied: [], skipped: [] })

const isSourceType = (value: string): value is InheritanceSourceType => SUPPORTED_INHERITANCE_PAIRS.some((pair) => pair.source === value)

function sourceIdFor(item: Item, sourceType: string): string | null {
  return sourceType === "OPPORTUNITY" ? item.opportunityId : sourceType === "SOLUTION" ? item.solutionId : null
}

/**
 * The shared per-item logic. Items are processed together so a late source value that fans out to many items
 * costs a fixed number of queries, but each item is decided independently: first rule (by priority) with a usable
 * value wins, later rules see the field as filled.
 */
async function fillEmptyTargets(
  tx: AppTransactionClient,
  workspaceId: string,
  targetObjectType: InheritanceTargetType,
  items: Item[],
): Promise<{ result: InheritanceResult; itemsApplied: Map<string, InheritedField[]> }> {
  const result = EMPTY()
  const itemsApplied = new Map<string, InheritedField[]>()
  const linked = items.filter((item) => item.opportunityId || item.solutionId)
  if (linked.length === 0) return { result, itemsApplied }

  const sourceTypes = SUPPORTED_INHERITANCE_PAIRS.filter((pair) => pair.target === targetObjectType).map((pair) => pair.source)
  const rules = (await tx.customFieldInheritanceRule.findMany({
    where: { workspaceId, targetObjectType, enabled: true, sourceObjectType: { in: sourceTypes } },
    orderBy: [{ priority: "asc" }, { id: "asc" }],
  })) as RuleRow[]
  if (rules.length === 0) return { result, itemsApplied }

  const fieldIds = [...new Set(rules.flatMap((rule) => [rule.targetFieldId, rule.sourceFieldId]))]
  const definitionRows = await tx.customFieldDefinition.findMany({
    where: { id: { in: fieldIds }, workspaceId },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  const definitions = new Map<string, CustomFieldDefinitionData>(definitionRows.map((row) => [row.id, toCustomFieldDefinitionData(row)]))

  // Source entities must still exist in THIS workspace: nothing cascades, so a deleted source leaves value rows behind.
  const liveSources = new Map<InheritanceSourceType, Set<string>>()
  for (const sourceType of sourceTypes) {
    const ids = [...new Set(linked.map((item) => sourceIdFor(item, sourceType)).filter((id): id is string => Boolean(id)))]
    if (ids.length === 0) continue
    const rows = sourceType === "OPPORTUNITY"
      ? await tx.opportunity.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })
      : await tx.solution.findMany({ where: { id: { in: ids }, workspaceId }, select: { id: true } })
    liveSources.set(sourceType, new Set(rows.map((row) => row.id)))
  }

  const targetFieldIds = [...new Set(rules.map((rule) => rule.targetFieldId))]
  const sourceFieldIds = [...new Set(rules.map((rule) => rule.sourceFieldId))]
  const sourceObjectIds = [...new Set([...liveSources.values()].flatMap((ids) => [...ids]))]
  const [targetValues, sourceValues] = await Promise.all([
    tx.customFieldValue.findMany({ where: { objectId: { in: linked.map((item) => item.id) }, fieldId: { in: targetFieldIds } }, select: { fieldId: true, objectId: true } }),
    sourceObjectIds.length === 0
      ? Promise.resolve([] as { fieldId: string; objectId: string; value: unknown }[])
      : tx.customFieldValue.findMany({ where: { objectId: { in: sourceObjectIds }, fieldId: { in: sourceFieldIds } }, select: { fieldId: true, objectId: true, value: true } }),
  ])
  const filled = new Set(targetValues.map((row) => `${row.fieldId}:${row.objectId}`))
  const sourceValueOf = new Map(sourceValues.map((row) => [`${row.fieldId}:${row.objectId}`, row.value as CustomFieldValue]))

  const rulesByTarget = new Map<string, RuleRow[]>()
  for (const rule of rules) rulesByTarget.set(rule.targetFieldId, [...(rulesByTarget.get(rule.targetFieldId) ?? []), rule])

  const inserts: { fieldId: string; objectId: string; value: object }[] = []
  const planned: { itemId: string; entry: InheritedField }[] = []
  for (const item of linked) {
    for (const [targetFieldId, group] of rulesByTarget) {
      if (filled.has(`${targetFieldId}:${item.id}`)) continue
      const target = definitions.get(targetFieldId)
      for (const rule of group) {
        const sourceType = rule.sourceObjectType
        const sourceId = sourceIdFor(item, sourceType)
        if (!sourceId || !isSourceType(sourceType) || !liveSources.get(sourceType)?.has(sourceId)) continue
        const source = definitions.get(rule.sourceFieldId)
        const value = sourceValueOf.get(`${rule.sourceFieldId}:${sourceId}`)
        if (value === undefined || value === null || isClearingValue(value)) continue
        const skip = (reason: InheritanceSkipReason) => result.skipped.push({ ruleId: rule.id, itemId: item.id, reason })
        if (!source || !target || target.objectType !== targetObjectType || source.objectType !== sourceType) { skip("field_missing"); continue }
        const incompatible = describeRuleIncompatibility(source, target)
        if (incompatible) { skip(incompatible.reason); continue }
        // Final guard: whatever the rule says, only a value the target field would itself accept is ever written.
        if (validateValueForFieldType(target.fieldType, target.options, value) !== null) { skip("invalid_value"); continue }
        inserts.push({ fieldId: targetFieldId, objectId: item.id, value: value as object })
        filled.add(`${targetFieldId}:${item.id}`)
        const entry: InheritedField = {
          ruleId: rule.id, fieldId: targetFieldId, fieldName: target.name, value,
          from: { objectType: sourceType, objectId: sourceId, fieldId: source.id, fieldName: source.name },
        }
        planned.push({ itemId: item.id, entry })
        break
      }
    }
  }

  // skipDuplicates turns a concurrent explicit write into a no-op instead of an error (which would abort the transaction), and the
  // rows it returns are the ones actually written: only those are reported as inherited.
  if (inserts.length > 0) {
    const written = await tx.customFieldValue.createManyAndReturn({ data: inserts, skipDuplicates: true, select: { fieldId: true, objectId: true } })
    const wrote = new Set(written.map((row) => `${row.fieldId}:${row.objectId}`))
    for (const { itemId, entry } of planned) {
      if (!wrote.has(`${entry.fieldId}:${itemId}`)) continue
      result.applied.push(entry)
      itemsApplied.set(itemId, [...(itemsApplied.get(itemId) ?? []), entry])
    }
  }
  return { result, itemsApplied }
}

/**
 * A roadmap item was created with a link, or its link changed to a new non-null value: fill its empty target fields.
 */
export async function applyInheritanceRules(
  tx: AppTransactionClient,
  input: { workspaceId: string; targetObjectType: InheritanceTargetType; targetId: string; links: InheritanceLinks },
): Promise<InheritanceResult> {
  const { workspaceId, targetObjectType, targetId } = input
  const opportunityId = input.links.opportunityId ?? null
  const solutionId = input.links.solutionId ?? null
  if (!opportunityId && !solutionId) return EMPTY()
  if (!SUPPORTED_INHERITANCE_PAIRS.some((pair) => pair.target === targetObjectType)) return EMPTY()
  if (!(await customFieldInheritanceTableExists())) return EMPTY()
  const { result } = await fillEmptyTargets(tx, workspaceId, targetObjectType, [{ id: targetId, opportunityId, solutionId }])
  return result
}

export type LateSourceResult = InheritanceResult & {
  /** Items whose target was filled, with the field and what it inherited. */
  applied: (InheritedField & { itemId: string })[]
  itemsScanned: number
  skippedByCap: number
}

/**
 * A source field value was set or changed on an OPPORTUNITY or SOLUTION: fill empty targets on the roadmap items
 * linked to it. Never rewrites a target, and clearing or changing the source later does nothing. One write handles at
 * most MAX_ITEMS_PER_SOURCE_WRITE items; the remainder is logged as a counted skip.
 */
export async function applyInheritanceForSourceValue(
  tx: AppTransactionClient,
  input: { workspaceId: string; sourceObjectType: InheritanceSourceType; sourceId: string; fieldId: string },
): Promise<LateSourceResult> {
  const { workspaceId, sourceObjectType, sourceId, fieldId } = input
  const empty = (): LateSourceResult => ({ applied: [], skipped: [], itemsScanned: 0, skippedByCap: 0 })
  const pair = SUPPORTED_INHERITANCE_PAIRS.find((candidate) => candidate.source === sourceObjectType)
  if (!pair) return empty()
  if (!(await customFieldInheritanceTableExists())) return empty()

  const feeding = await tx.customFieldInheritanceRule.findMany({
    where: { workspaceId, targetObjectType: pair.target, enabled: true, sourceObjectType, sourceFieldId: fieldId },
  })
  if (feeding.length === 0) return empty()

  // Window: the first MAX_ITEMS_PER_SOURCE_WRITE ACTIVE linked items that still have an empty target for a rule, in id order. Items whose
  // targets are already filled take no slot, so a later write keeps progressing past the cap instead of re-reading the same first page.
  const targetFieldIds = [...new Set(feeding.map((rule) => rule.targetFieldId))]
  const baseWhere = { workspaceId, status: "ACTIVE", [pair.linkColumn]: sourceId }
  const items: Item[] = []
  let cursor: string | null = null
  let exhausted = false
  while (items.length < MAX_ITEMS_PER_SOURCE_WRITE && !exhausted) {
    const page = (await tx.roadmapItem.findMany({
      where: cursor ? { ...baseWhere, id: { gt: cursor } } : baseWhere,
      select: { id: true, opportunityId: true, solutionId: true },
      orderBy: { id: "asc" },
      take: MAX_ITEMS_PER_SOURCE_WRITE,
    })) as Item[]
    if (page.length < MAX_ITEMS_PER_SOURCE_WRITE) exhausted = true
    if (page.length === 0) break
    cursor = page[page.length - 1].id
    const have = await tx.customFieldValue.findMany({ where: { objectId: { in: page.map((item) => item.id) }, fieldId: { in: targetFieldIds } }, select: { fieldId: true, objectId: true } })
    const filledCount = new Map<string, number>()
    for (const row of have) filledCount.set(row.objectId, (filledCount.get(row.objectId) ?? 0) + 1)
    for (const item of page) {
      if ((filledCount.get(item.id) ?? 0) >= targetFieldIds.length) continue
      if (items.length < MAX_ITEMS_PER_SOURCE_WRITE) items.push(item)
      else { exhausted = true; break }
    }
  }
  let skippedByCap = 0
  if (items.length >= MAX_ITEMS_PER_SOURCE_WRITE && cursor) {
    // Linked ACTIVE items past the window (not yet examined): the next write for this source starts with them.
    skippedByCap = await tx.roadmapItem.count({ where: { ...baseWhere, id: { gt: items[items.length - 1].id } } })
    if (skippedByCap > 0) {
      console.warn("[custom-field-inheritance] source value fan-out capped; the remaining linked items were not examined and are picked up by the next write", {
        workspaceId, sourceObjectType, sourceId, fieldId, processed: items.length, skippedByCap,
      })
    }
  }

  const { result, itemsApplied } = await fillEmptyTargets(tx, workspaceId, pair.target, items)
  const applied = [...itemsApplied].flatMap(([itemId, entries]) => entries.map((entry) => ({ ...entry, itemId })))
  return { applied, skipped: result.skipped, itemsScanned: items.length, skippedByCap }
}
