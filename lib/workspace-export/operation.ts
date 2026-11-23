import { importSchema } from "./import-schema"
import { randomUUID } from "node:crypto"
import type { ImportReport } from "./import"
import { ImportOwnershipChanged, type ImportLeaseOwner } from "./lease"

export type ImportDatabase = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>
}

export async function startImportOperation(db: ImportDatabase, workspaceId: string, organizationId: string, schema?: string): Promise<ImportLeaseOwner> {
  const attemptId = randomUUID()
  const rows = await db.$queryRawUnsafe<{ epoch: number }[]>(
    `INSERT INTO ${importSchema(schema)}.workspace_import_operations AS operation (workspace_id, organization_id, attempt_id, phase, lease_expires_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'applying', CURRENT_TIMESTAMP + interval '5 minutes', CURRENT_TIMESTAMP)
     ON CONFLICT (workspace_id) DO UPDATE
       SET attempt_id=EXCLUDED.attempt_id, epoch=operation.epoch+1, phase='applying',
           lease_expires_at=EXCLUDED.lease_expires_at, updated_at=CURRENT_TIMESTAMP
       WHERE operation.organization_id=EXCLUDED.organization_id AND operation.phase='rolled_back'
     RETURNING epoch`, workspaceId, organizationId, attemptId,
  )
  if (!rows.length) throw new Error("Workspace import is already in progress or awaiting recovery")
  return { workspaceId, attemptId, epoch: rows[0].epoch }
}

export async function commitImportReport(tx: ImportDatabase, owner: ImportLeaseOwner, report: ImportReport, schema?: string): Promise<void> {
  const rows = await tx.$queryRawUnsafe<{ epoch: number }[]>(
    `UPDATE ${importSchema(schema)}.workspace_import_operations SET phase = 'committed', result_text = $4, updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1::uuid AND attempt_id = $2::uuid AND epoch = $3 AND phase = 'applying'
       AND lease_expires_at > CURRENT_TIMESTAMP RETURNING epoch`,
    owner.workspaceId, owner.attemptId, owner.epoch, JSON.stringify(report),
  )
  if (rows.length !== 1) throw new ImportOwnershipChanged()
}

/** Renew within the transaction whose writes depend on this owner. */
export async function renewImportOperation(
  db: ImportDatabase, owner: ImportLeaseOwner, phase: "applying" | "rolling_back" | "recovering", schema?: string,
): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ epoch: number }[]>(
    `UPDATE ${importSchema(schema)}.workspace_import_operations
     SET phase = $4, lease_expires_at = CURRENT_TIMESTAMP + interval '5 minutes', updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1::uuid AND attempt_id = $2::uuid AND epoch = $3 AND (phase = $4 OR ($4 = 'rolling_back' AND phase = 'applying'))
       AND lease_expires_at > CURRENT_TIMESTAMP RETURNING epoch`,
    owner.workspaceId, owner.attemptId, owner.epoch, phase,
  )
  if (rows.length !== 1) throw new ImportOwnershipChanged()
}


export async function finishImportRollback(db: ImportDatabase, owner: ImportLeaseOwner, schema?: string): Promise<void> {
  const rows = await db.$queryRawUnsafe<{ epoch: number }[]>(
    `UPDATE ${importSchema(schema)}.workspace_import_operations SET phase='rolled_back', updated_at=CURRENT_TIMESTAMP
     WHERE workspace_id=$1::uuid AND attempt_id=$2::uuid AND epoch=$3 AND phase='rolling_back'
       AND lease_expires_at>CURRENT_TIMESTAMP RETURNING epoch`, owner.workspaceId, owner.attemptId, owner.epoch,
  )
  if (rows.length !== 1) throw new ImportOwnershipChanged()
}

export async function claimBundleImport(db: ImportDatabase, workspaceId: string, organizationId: string, digest: string) {
  const attemptId = randomUUID()
  const rows = await db.$queryRawUnsafe<{ epoch: number; phase: "recovering" | "applying" }[]>(
    `INSERT INTO ${importSchema()}.workspace_import_operations AS old
       (workspace_id, organization_id, attempt_id, bundle_digest, phase, lease_expires_at, updated_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'applying',CURRENT_TIMESTAMP+interval '5 minutes',CURRENT_TIMESTAMP)
     ON CONFLICT (workspace_id) DO UPDATE
       SET attempt_id=EXCLUDED.attempt_id, epoch=old.epoch+1, updated_at=CURRENT_TIMESTAMP,
           lease_expires_at=EXCLUDED.lease_expires_at,
           phase=CASE WHEN old.phase='rolled_back' THEN 'applying' ELSE 'recovering' END
       WHERE old.organization_id=EXCLUDED.organization_id AND old.bundle_digest=EXCLUDED.bundle_digest
         AND (old.phase='rolled_back' OR (old.phase IN ('applying','recovering','rolling_back','cleanup_pending')
              AND old.lease_expires_at<=CURRENT_TIMESTAMP))
     RETURNING epoch, phase`, workspaceId, organizationId, attemptId, digest,
  )
  if (!rows.length) throw new Error("Workspace import is in progress or requires the original bundle")
  return { workspaceId, attemptId, ...rows[0] }
}

export async function resumeRecoveredImport(db: ImportDatabase, owner: ImportLeaseOwner) {
  const rows = await db.$queryRawUnsafe<{ epoch: number }[]>(
    `UPDATE ${importSchema()}.workspace_import_operations SET phase='applying', updated_at=CURRENT_TIMESTAMP,
       lease_expires_at=CURRENT_TIMESTAMP+interval '5 minutes'
     WHERE workspace_id=$1::uuid AND attempt_id=$2::uuid AND epoch=$3
       AND phase='recovering' AND lease_expires_at>CURRENT_TIMESTAMP RETURNING epoch`,
    owner.workspaceId, owner.attemptId, owner.epoch,
  )
  if (rows.length !== 1) throw new ImportOwnershipChanged()
}
