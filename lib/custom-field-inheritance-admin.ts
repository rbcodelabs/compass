/**
 * Rule management for custom field inheritance (Settings only, ADR 0013): create, enable/disable, reorder,
 * delete, list. Every function takes the caller's workspaceId (resolved server-side from the session, never from
 * the client) and checks every field id against it, because relationMode = "prisma" and DSQL give us no foreign
 * keys to do it for us. The MCP surface is read-only and uses listInheritanceRules only.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { toCustomFieldDefinitionData } from "@/lib/custom-field-definitions"
import { checkRuleCompatibility, describeRuleIncompatibility, SUPPORTED_INHERITANCE_PAIRS } from "@/lib/custom-field-inheritance-compat"
import { customFieldInheritanceTableExists } from "@/lib/feature-tables"
import type { CustomFieldDefinitionData } from "@/lib/types"

export { checkRuleCompatibility }

type Db = AppPrismaClient | AppTransactionClient

export class InheritanceRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InheritanceRuleError"
  }
}

const isCode = (error: unknown, code: string) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === code

export type InheritanceRuleStatus = "active" | "disabled" | "inactive"

export type InheritanceRuleListItem = {
  id: string
  workspaceId: string
  targetObjectType: string
  targetFieldId: string
  targetFieldName: string | null
  sourceObjectType: string
  sourceFieldId: string
  sourceFieldName: string | null
  priority: number
  enabled: boolean
  status: InheritanceRuleStatus
  inactiveReason: string | null
  source: string
  createdAt: Date
}

async function loadDefinitions(db: Db, workspaceId: string, ids: string[]): Promise<Map<string, CustomFieldDefinitionData>> {
  const rows = await db.customFieldDefinition.findMany({
    where: { id: { in: ids }, workspaceId },
    include: { sharedOptionSet: { select: { id: true, name: true, options: true } } },
  })
  return new Map(rows.map((row) => [row.id, toCustomFieldDefinitionData(row)]))
}

export async function createInheritanceRule(
  db: Db,
  input: { workspaceId: string; targetFieldId: string; sourceFieldId: string; priority?: number; actorUserId?: string | null; source?: "UI" | "MCP" },
) {
  const { workspaceId, targetFieldId, sourceFieldId } = input
  // A foreign or missing field is indistinguishable from the caller's side: nothing about other workspaces leaks.
  const definitions = await loadDefinitions(db, workspaceId, [targetFieldId, sourceFieldId])
  const target = definitions.get(targetFieldId)
  const source = definitions.get(sourceFieldId)
  if (!target || !source) throw new InheritanceRuleError("Field not found")

  if (!SUPPORTED_INHERITANCE_PAIRS.some((pair) => pair.target === target.objectType)) {
    throw new InheritanceRuleError("The target field must be a roadmap item field")
  }
  const pair = SUPPORTED_INHERITANCE_PAIRS.find((candidate) => candidate.target === target.objectType && candidate.source === source.objectType)
  if (!pair) throw new InheritanceRuleError("The source field must be an opportunity or solution field")
  const incompatible = checkRuleCompatibility(source, target)
  if (incompatible) throw new InheritanceRuleError(incompatible)

  let priority = input.priority
  if (priority === undefined) {
    const siblings = await db.customFieldInheritanceRule.findMany({ where: { workspaceId, targetFieldId }, select: { priority: true } })
    priority = siblings.length === 0 ? 0 : Math.max(...siblings.map((row) => row.priority)) + 1
  }

  try {
    return await db.customFieldInheritanceRule.create({
      data: {
        workspaceId,
        targetObjectType: pair.target,
        targetFieldId,
        sourceObjectType: pair.source,
        sourceFieldId,
        priority,
        enabled: true,
        createdById: input.actorUserId ?? null,
        updatedById: input.actorUserId ?? null,
        source: input.source ?? "UI",
        // No @updatedAt on DSQL: stamped explicitly on every write.
        updatedAt: new Date(),
      },
    })
  } catch (error) {
    if (isCode(error, "P2002")) throw new InheritanceRuleError("That rule already exists for this target field, or its priority is taken")
    if (isCode(error, "P2021")) throw new InheritanceRuleError("Inheritance rules are not available until the 113_custom_field_inheritance_rules migration is applied")
    throw error
  }
}

export async function setInheritanceRuleEnabled(db: Db, workspaceId: string, ruleId: string, enabled: boolean): Promise<void> {
  const updated = await db.customFieldInheritanceRule.updateMany({ where: { id: ruleId, workspaceId }, data: { enabled, updatedAt: new Date() } })
  if (updated.count !== 1) throw new InheritanceRuleError("Rule not found")
}

export async function deleteInheritanceRule(db: Db, workspaceId: string, ruleId: string): Promise<void> {
  const deleted = await db.customFieldInheritanceRule.deleteMany({ where: { id: ruleId, workspaceId } })
  if (deleted.count !== 1) throw new InheritanceRuleError("Rule not found")
}

/** Swap priority with the neighbour for the same target field. The top rule moving up (or the bottom one down) is a no-op. */
export async function moveInheritanceRule(db: Db, workspaceId: string, ruleId: string, direction: "up" | "down"): Promise<void> {
  const rule = await db.customFieldInheritanceRule.findFirst({ where: { id: ruleId, workspaceId } })
  if (!rule) throw new InheritanceRuleError("Rule not found")
  const siblings = (await db.customFieldInheritanceRule.findMany({ where: { workspaceId, targetFieldId: rule.targetFieldId } })).sort((a, b) => a.priority - b.priority)
  const index = siblings.findIndex((row) => row.id === rule.id)
  const neighbour = siblings[direction === "up" ? index - 1 : index + 1]
  if (!neighbour) return
  const now = new Date()
  // (workspace, target field, priority) is unique, so the swap goes through a free slot.
  await db.customFieldInheritanceRule.updateMany({ where: { id: rule.id, workspaceId }, data: { priority: -1, updatedAt: now } })
  await db.customFieldInheritanceRule.updateMany({ where: { id: neighbour.id, workspaceId }, data: { priority: rule.priority, updatedAt: now } })
  await db.customFieldInheritanceRule.updateMany({ where: { id: rule.id, workspaceId }, data: { priority: neighbour.priority, updatedAt: now } })
}

/** deleteFieldDefinition calls this: nothing cascades, so a deleted field must take its rules with it. */
export async function deleteInheritanceRulesForField(db: Db, workspaceId: string, fieldId: string): Promise<void> {
  if (!(await customFieldInheritanceTableExists())) return
  await db.customFieldInheritanceRule.deleteMany({ where: { workspaceId, targetFieldId: fieldId } })
  await db.customFieldInheritanceRule.deleteMany({ where: { workspaceId, sourceFieldId: fieldId } })
}

/** Rules in evaluation order (per target field, by priority) with the names and an active / disabled / inactive status. */
export async function listInheritanceRules(db: Db, workspaceId: string): Promise<InheritanceRuleListItem[]> {
  const rules = (await db.customFieldInheritanceRule.findMany({ where: { workspaceId } })).sort(
    (a, b) => a.targetFieldId.localeCompare(b.targetFieldId) || a.priority - b.priority,
  )
  if (rules.length === 0) return []
  const definitions = await loadDefinitions(db, workspaceId, [...new Set(rules.flatMap((rule) => [rule.targetFieldId, rule.sourceFieldId]))])
  return rules.map((rule) => {
    const source = definitions.get(rule.sourceFieldId)
    const target = definitions.get(rule.targetFieldId)
    const incompatible = source && target ? describeRuleIncompatibility(source, target) : null
    const inactiveReason = !source || !target ? "Field missing" : incompatible?.message ?? null
    return {
      id: rule.id,
      workspaceId: rule.workspaceId,
      targetObjectType: rule.targetObjectType,
      targetFieldId: rule.targetFieldId,
      targetFieldName: target?.name ?? null,
      sourceObjectType: rule.sourceObjectType,
      sourceFieldId: rule.sourceFieldId,
      sourceFieldName: source?.name ?? null,
      priority: rule.priority,
      enabled: rule.enabled,
      status: inactiveReason ? "inactive" : rule.enabled ? "active" : "disabled",
      inactiveReason,
      source: rule.source,
      createdAt: rule.createdAt,
    }
  })
}
