import type { PoolClient } from "pg"

type LeaseTransaction = Pick<PoolClient, "query">

export type ImportLeaseOwner = { workspaceId: string; attemptId: string; epoch: number }
export type ImportLeasePhase = "applying" | "recovering" | "rolling_back"

export class ImportOwnershipChanged extends Error {
  constructor() {
    super("Workspace import ownership changed")
  }
}

/** Call in the transaction that changes import rows or the journal. */
export async function fenceImportLease(
  tx: LeaseTransaction,
  owner: ImportLeaseOwner,
  phase: ImportLeasePhase,
): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE workspace_import_operations
     SET updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND attempt_id = $2 AND epoch = $3 AND phase = $4
       AND lease_expires_at > CURRENT_TIMESTAMP`,
    [owner.workspaceId, owner.attemptId, owner.epoch, phase],
  )
  if (rowCount !== 1) throw new ImportOwnershipChanged()
}

/** Recover only the exact expired lease that the caller observed. */
export async function takeOverImportLease(
  tx: LeaseTransaction,
  owner: ImportLeaseOwner,
  nextAttemptId: string,
  leaseMs: number,
): Promise<ImportLeaseOwner | null> {
  const { rows } = await tx.query<ImportLeaseOwner>(
    `UPDATE workspace_import_operations
     SET attempt_id = $4, epoch = epoch + 1, phase = 'recovering',
         updated_at = CURRENT_TIMESTAMP,
         lease_expires_at = CURRENT_TIMESTAMP + $5::integer * interval '1 millisecond'
     WHERE workspace_id = $1 AND attempt_id = $2 AND epoch = $3
       AND phase IN ('applying', 'recovering', 'rolling_back')
       AND lease_expires_at <= CURRENT_TIMESTAMP
     RETURNING workspace_id AS "workspaceId", attempt_id AS "attemptId", epoch`,
    [owner.workspaceId, owner.attemptId, owner.epoch, nextAttemptId, leaseMs],
  )
  return rows[0] ?? null
}
