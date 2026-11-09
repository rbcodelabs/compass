/**
 * The one funnel for writing a custom field value (Settings UI, discovery board, MCP set_custom_field_value(s),
 * REST setCustomFieldValue). It exists so that the "late source value" inheritance hook (ADR: Custom field
 * inheritance rules) is reachable from every write path: __tests__/custom-field-inheritance-guard.test.ts fails
 * if a customFieldValue upsert appears anywhere else.
 *
 * Callers do their own authorization and validation first (each surface validates differently); this only writes.
 * Clearing (null, "" or []) deletes the row and never touches inheritance targets.
 */
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db"
import { applyInheritanceForSourceValue, type InheritanceSourceType } from "@/lib/custom-field-inheritance"
import { isClearingValue } from "@/lib/custom-field-validation"
import { customFieldInheritanceTableExists } from "@/lib/feature-tables"
import { retryUpdatesTransaction } from "@/lib/workspace-updates-capture"
import type { CustomFieldObjectType, CustomFieldValue } from "@/lib/types"

export { isClearingValue }

const SOURCE_TYPES: ReadonlySet<string> = new Set<InheritanceSourceType>(["OPPORTUNITY", "SOLUTION"])

export async function writeCustomFieldValue(
  prisma: AppPrismaClient,
  input: { workspaceId: string; objectType: CustomFieldObjectType; objectId: string; fieldId: string; value: CustomFieldValue },
): Promise<{ cleared: boolean; inheritedItems: number }> {
  const { workspaceId, objectType, objectId, fieldId, value } = input

  if (isClearingValue(value)) {
    await prisma.customFieldValue.deleteMany({ where: { fieldId, objectId } })
    return { cleared: true, inheritedItems: 0 }
  }

  const write = (db: AppPrismaClient | AppTransactionClient) =>
    db.customFieldValue.upsert({
      where: { fieldId_objectId: { fieldId, objectId } },
      create: { fieldId, objectId, value: value as object },
      update: { value: value as object, updatedAt: new Date() },
    })

  // Only OPPORTUNITY / SOLUTION values can feed a rule, and only once the rules table exists: everything else stays a plain write.
  if (!SOURCE_TYPES.has(objectType) || !(await customFieldInheritanceTableExists())) {
    await write(prisma)
    return { cleared: false, inheritedItems: 0 }
  }

  const late = await retryUpdatesTransaction(prisma, async (tx) => {
    await write(tx)
    return applyInheritanceForSourceValue(tx, { workspaceId, sourceObjectType: objectType as InheritanceSourceType, sourceId: objectId, fieldId })
  })
  return { cleared: false, inheritedItems: late.applied.length }
}
