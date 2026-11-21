import { importSchema } from "./import-schema"
import type { ImportDatabase } from "./operation"
import type { ProviderIdentity } from "./asset-journal"

type Asset = ProviderIdentity & { physicalKey: string; state: "reserved" | "verified" }
type CleanupAdapter = ProviderIdentity & { remove(key: string): Promise<void> }
type CleanupRecord = Asset & { workspaceId: string; attemptId: string; logicalKey: string; store: "artifact" | "research" | "feedback" }

export async function reclaimAbandonedAsset(asset: Asset, adapter: CleanupAdapter) {
  if (adapter.provider !== asset.provider || adapter.namespace !== asset.namespace) return "pending"
  await adapter.remove(asset.physicalKey)
  // A PUT with an unknown outcome may arrive after this DELETE.
  return asset.state === "verified" ? "cleaned" : "pending"
}

export async function sweepAbandonedAssets(db: ImportDatabase, adapterFor: (store: CleanupRecord["store"]) => CleanupAdapter) {
  // The worker can retire attempt-owned bytes without the ZIP. Keep the digest and
  // leave row reconciliation to a subsequent claimant presenting the original bundle.
  const operations = importSchema() + ".workspace_import_operations"
  const expired = await db.$queryRawUnsafe<{ workspace_id: string; attempt_id: string; epoch: number }[]>(
    `SELECT workspace_id, attempt_id, epoch FROM ${operations}
     WHERE phase IN ('applying','rolling_back','recovering') AND lease_expires_at<=CURRENT_TIMESTAMP
     ORDER BY lease_expires_at, workspace_id LIMIT 25`,
  )
  for (const owner of expired) {
    await db.$queryRawUnsafe(
      `UPDATE ${operations} SET phase='cleanup_pending', epoch=epoch+1, updated_at=CURRENT_TIMESTAMP
       WHERE workspace_id=$1::uuid AND attempt_id=$2::uuid AND epoch=$3
         AND phase IN ('applying','rolling_back','recovering') AND lease_expires_at<=CURRENT_TIMESTAMP
       RETURNING epoch`, owner.workspace_id, owner.attempt_id, owner.epoch,
    )
  }
  const rows = await db.$queryRawUnsafe<CleanupRecord[]>(
    `SELECT a.attempt_id AS "attemptId", a.workspace_id AS "workspaceId", a.logical_key AS "logicalKey",
            a.physical_key AS "physicalKey", a.backend AS store, a.state, a.provider_id AS provider, a.namespace_id AS namespace
     FROM ${importSchema()}.workspace_import_assets a
     JOIN ${importSchema()}.workspace_import_operations o ON o.workspace_id=a.workspace_id
     WHERE (a.attempt_id<>o.attempt_id OR o.phase IN ('rolled_back','cleanup_pending')) AND a.state IN ('reserved','verified')
     ORDER BY a.updated_at, a.attempt_id, a.logical_key LIMIT 25`,
  )
  let cleaned = 0
  for (const asset of rows) {
    let state: string = asset.state
    try {
      const prefix = asset.store === "feedback" ? `feedback/${asset.workspaceId}/${asset.attemptId}-`
        : `workspace-import-assets/${asset.workspaceId}/${asset.attemptId}/${asset.store}/`
      if (asset.physicalKey.startsWith(prefix) && /^[0-9a-f]{64}$/.test(asset.physicalKey.slice(prefix.length))) {
        if (await reclaimAbandonedAsset(asset, adapterFor(asset.store)) === "cleaned") {
          state = "cleaned"
          cleaned++
        }
      }
    } catch (error) {
      console.error("[workspace-import] asset cleanup remains pending", asset.attemptId, error instanceof Error ? error.name : "provider failure")
    }
    await db.$queryRawUnsafe(
      `UPDATE ${importSchema()}.workspace_import_assets SET state=$3, updated_at=CURRENT_TIMESTAMP
       WHERE attempt_id=$1::uuid AND logical_key=$2 AND state=$4 RETURNING logical_key`,
      asset.attemptId, asset.logicalKey, state, asset.state,
    )
  }
  return { considered: rows.length, cleaned }
}
