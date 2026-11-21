import type { ImportDatabase } from "./operation"
import type { ImportReport } from "@/lib/workspace-export/import"

type ReceiptDatabase = ImportDatabase

type ReceiptScope = {
  digest: string
  organizationId: string
  userId: string
  nonce: string
}

type ReceiptBinding = ReceiptScope & { workspaceId: string; expiresAt: Date }

export async function bindImportReceipt(db: ReceiptDatabase, binding: ReceiptBinding): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ receipt_digest: string }[]>(
    `INSERT INTO workspace_import_receipts
       (receipt_digest, workspace_id, organization_id, user_id, effective_nonce, expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4::uuid, $5, $6::timestamp)
     ON CONFLICT (receipt_digest) DO UPDATE SET effective_nonce = EXCLUDED.effective_nonce
     WHERE workspace_import_receipts.workspace_id = EXCLUDED.workspace_id
       AND workspace_import_receipts.organization_id = EXCLUDED.organization_id
       AND workspace_import_receipts.user_id = EXCLUDED.user_id
       AND workspace_import_receipts.effective_nonce = EXCLUDED.effective_nonce
       AND workspace_import_receipts.expires_at = EXCLUDED.expires_at
     RETURNING receipt_digest`,
    binding.digest, binding.workspaceId, binding.organizationId, binding.userId, binding.nonce, binding.expiresAt,
  )
  if (rows.length !== 1) throw new Error("Workspace import receipt binding conflicts with an earlier request")
}

export async function readImportReceiptResult(db: ReceiptDatabase, scope: ReceiptScope): Promise<ImportReport | null> {
  const [row] = await db.$queryRawUnsafe<{ result_text: string }[]>(
    `SELECT operation.result_text
     FROM workspace_import_receipts AS receipt
     JOIN workspace_import_operations AS operation
       ON operation.workspace_id = receipt.workspace_id
       AND operation.organization_id = receipt.organization_id
     WHERE receipt.receipt_digest = $1 AND receipt.organization_id = $2::uuid
       AND receipt.user_id = $3::uuid AND receipt.effective_nonce = $4
       AND receipt.expires_at > CURRENT_TIMESTAMP
       AND operation.phase = 'committed' AND operation.result_text IS NOT NULL`,
    scope.digest, scope.organizationId, scope.userId, scope.nonce,
  )
  return row ? JSON.parse(row.result_text) as ImportReport : null
}
