import { randomUUID } from "node:crypto"
import type { ImportReport } from "./import"
import { ImportOwnershipChanged, type ImportLeaseOwner } from "./lease"

export type ImportDatabase = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>
}

export async function startImportOperation(db: ImportDatabase, workspaceId: string, organizationId: string): Promise<ImportLeaseOwner> {
  const attemptId = randomUUID()
  const rows = await db.$queryRawUnsafe<{ epoch: number }[]>(
    `INSERT INTO workspace_import_operations (workspace_id, organization_id, attempt_id, phase, lease_expires_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'applying', CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP)
     ON CONFLICT (workspace_id) DO NOTHING RETURNING epoch`, workspaceId, organizationId, attemptId,
  )
  if (!rows.length) throw new Error("Workspace import is already in progress or awaiting recovery")
  return { workspaceId, attemptId, epoch: rows[0].epoch }
}

export async function commitImportReport(tx: ImportDatabase, owner: ImportLeaseOwner, report: ImportReport): Promise<void> {
  const rows = await tx.$queryRawUnsafe<{ epoch: number }[]>(
    `UPDATE workspace_import_operations SET phase = 'committed', result_text = $4, updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1::uuid AND attempt_id = $2::uuid AND epoch = $3 AND phase = 'applying'
       AND lease_expires_at > CURRENT_TIMESTAMP RETURNING epoch`,
    owner.workspaceId, owner.attemptId, owner.epoch, JSON.stringify(report),
  )
  if (rows.length !== 1) throw new ImportOwnershipChanged()
}
