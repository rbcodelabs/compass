import { createHash } from "node:crypto"
import { importSchema } from "./import-schema"
import type { ImportLeaseOwner } from "./lease"
import { renewImportOperation, type ImportDatabase } from "./operation"

export type ProviderIdentity = { provider: string; namespace: string }
type AssetStore = "artifact" | "research" | "feedback"

function logicalIdentity(store: AssetStore, path: string) {
  return store + ":" + createHash("sha256").update(path).digest("hex")
}

/** The caller commits this transaction before issuing the provider write. */
export async function reserveImportAsset(tx: ImportDatabase, owner: ImportLeaseOwner, store: AssetStore, path: string, identity: ProviderIdentity & { bytes: number; sha256: string }) {
  await renewImportOperation(tx, owner, "applying")
  const logical = logicalIdentity(store, path)
  const physical = store === "feedback"
    ? `feedback/${owner.workspaceId}/${owner.attemptId}-${logical.split(":")[1]}`
    : `workspace-import-assets/${owner.workspaceId}/${owner.attemptId}/${store}/${logical.split(":")[1]}`
  await tx.$queryRawUnsafe(
    `INSERT INTO ${importSchema()}.workspace_import_assets
       (attempt_id, workspace_id, logical_key, physical_key, backend, state, provider_id, namespace_id, expected_bytes, expected_sha256)
     VALUES ($1::uuid,$2::uuid,$3,$4,$5,'reserved',$6,$7,$8,$9) RETURNING logical_key`,
    owner.attemptId, owner.workspaceId, logical, physical, store, identity.provider, identity.namespace, identity.bytes, identity.sha256,
  )
  await tx.$queryRawUnsafe(
    `INSERT INTO ${importSchema()}.workspace_import_required_assets (attempt_id, logical_key)
     VALUES ($1::uuid,$2) RETURNING logical_key`, owner.attemptId, logical,
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

export async function lookupImportAssetMapping(db: ImportDatabase, workspaceId: string, store: AssetStore, path: string, currentProvider?: () => ProviderIdentity) {
  const [row] = await db.$queryRawUnsafe<{ physical_key: string | null; expected_sha256: string; provider_id: string; namespace_id: string }[]>(
    `SELECT a.physical_key, a.expected_sha256, a.provider_id, a.namespace_id FROM ${importSchema()}.workspace_import_operations o
     JOIN ${importSchema()}.workspace_import_required_assets r ON r.attempt_id=o.attempt_id
     LEFT JOIN ${importSchema()}.workspace_import_assets a
       ON a.workspace_id=o.workspace_id AND a.attempt_id=r.attempt_id AND a.logical_key=r.logical_key
       AND a.backend=$3 AND a.state='verified'
     WHERE o.workspace_id=$1::uuid AND o.phase='committed' AND r.logical_key=$2`,
    workspaceId, logicalIdentity(store, path), store,
  )
  if (row && !row.physical_key) throw new Error("Required import asset mapping is unavailable")
  if (row && currentProvider) {
    const active = currentProvider()
    if (row.provider_id !== active.provider || row.namespace_id !== active.namespace) {
      throw new Error("Import asset provider namespace is unavailable")
    }
  }
  return row?.physical_key ? { path: row.physical_key, digest: row.expected_sha256 } : null
}

export async function lookupImportAsset(...args: Parameters<typeof lookupImportAssetMapping>) {
  return (await lookupImportAssetMapping(...args))?.path ?? null
}
