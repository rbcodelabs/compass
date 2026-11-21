import { createHash } from "node:crypto"
import { importSchema } from "./import-schema"
import type { ImportLeaseOwner } from "./lease"
import { renewImportOperation, type ImportDatabase } from "./operation"

type AssetStore = "artifact" | "research" | "feedback"

function logicalIdentity(store: AssetStore, path: string) {
  return store + ":" + createHash("sha256").update(path).digest("hex")
}

/** The caller commits this transaction before issuing the provider write. */
export async function reserveImportAsset(tx: ImportDatabase, owner: ImportLeaseOwner, store: AssetStore, path: string) {
  await renewImportOperation(tx, owner, "applying")
  const logical = logicalIdentity(store, path)
  const physical = `workspace-import-assets/${owner.workspaceId}/${owner.attemptId}/${store}/${logical.split(":")[1]}`
  await tx.$queryRawUnsafe(
    `INSERT INTO ${importSchema()}.workspace_import_assets
       (attempt_id, workspace_id, logical_key, physical_key, backend, state)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,'reserved') RETURNING logical_key`,
    owner.attemptId, owner.workspaceId, logical, physical, store,
  )
  return physical
}

/** The caller verifies the provider's stored bytes before entering this transaction. */
export async function verifyImportAsset(tx: ImportDatabase, owner: ImportLeaseOwner, store: AssetStore, path: string, physical: string) {
  await renewImportOperation(tx, owner, "applying")
  const rows = await tx.$queryRawUnsafe<{ logical_key: string }[]>(
    `UPDATE ${importSchema()}.workspace_import_assets SET state='verified', updated_at=CURRENT_TIMESTAMP
     WHERE attempt_id=$1::uuid AND workspace_id=$2::uuid AND logical_key=$3 AND physical_key=$4
       AND backend=$5 AND state='reserved' RETURNING logical_key`,
    owner.attemptId, owner.workspaceId, logicalIdentity(store, path), physical, store,
  )
  if (rows.length !== 1) throw new Error("Import asset reservation is unavailable")
}

export async function lookupImportAsset(db: ImportDatabase, workspaceId: string, store: AssetStore, path: string) {
  const [row] = await db.$queryRawUnsafe<{ physical_key: string }[]>(
    `SELECT a.physical_key FROM ${importSchema()}.workspace_import_assets a
     JOIN ${importSchema()}.workspace_import_operations o ON o.workspace_id=a.workspace_id AND o.attempt_id=a.attempt_id
     WHERE o.workspace_id=$1::uuid AND o.phase='committed' AND a.logical_key=$2 AND a.backend=$3 AND a.state='verified'`,
    workspaceId, logicalIdentity(store, path), store,
  )
  return row?.physical_key ?? null
}
