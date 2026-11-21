import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { expect, it, vi } from "vitest"
import { integrationDatabaseUrl } from "./helpers/integration-database"

vi.mock("@/lib/schema", () => ({ getActiveSchema: () => "pg_temp" }))

it.skipIf(!integrationDatabaseUrl)("keeps uncertain writes journaled and exposes only verified assets of the committed attempt", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  try {
    await db.query(`CREATE TEMP TABLE workspace_import_operations (
      workspace_id uuid PRIMARY KEY, attempt_id uuid, epoch integer, phase text, lease_expires_at timestamp, updated_at timestamp)`)
    await db.query(`CREATE TEMP TABLE workspace_import_assets (
      attempt_id uuid, workspace_id uuid, logical_key text, physical_key text, backend text, state text, provider_id text, namespace_id text, expected_bytes bigint, expected_sha256 text,
      updated_at timestamp DEFAULT now(), PRIMARY KEY(attempt_id,logical_key))`)
    await db.query("CREATE TEMP TABLE workspace_import_required_assets (attempt_id uuid, logical_key text, PRIMARY KEY(attempt_id,logical_key))")
    const owner = { attemptId: randomUUID(), workspaceId: randomUUID(), epoch: 1 }
    const logical = "docs/" + owner.workspaceId + "/images/chart.png"
    await db.query("INSERT INTO workspace_import_operations VALUES ($1,$2,1,'applying', now()+interval '1 minute',now())", [owner.workspaceId,owner.attemptId])
    const tx = { async $queryRawUnsafe<T>(sql: string, ...args: unknown[]) { return (await db.query(sql,args)).rows as T } }
    const { reserveImportAsset, verifyImportAsset, lookupImportAsset } = await import("@/lib/workspace-export/asset-journal")
    const identity = { provider: "blob", namespace: "fixture-store", bytes: 10, sha256: "b".repeat(64) }
    const key = await reserveImportAsset(tx, owner, "artifact", logical, identity)
    expect((await db.query("SELECT provider_id, namespace_id, expected_bytes, expected_sha256 FROM workspace_import_assets")).rows[0]).toEqual({
      provider_id: identity.provider, namespace_id: identity.namespace, expected_bytes: "10", expected_sha256: identity.sha256,
    })
    expect(key).toContain(owner.attemptId)
    expect((await db.query("SELECT state FROM workspace_import_assets")).rows[0].state).toBe("reserved")
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBeNull()
    await verifyImportAsset(tx, owner, "artifact", logical, key)
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBeNull()
    await db.query("UPDATE workspace_import_operations SET phase='committed'")
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBe(key)
    await db.query("UPDATE workspace_import_assets SET state='reserved'")
    await expect(lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).rejects.toThrow(/mapping/i)
    await db.query("DELETE FROM workspace_import_assets")
    await expect(lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).rejects.toThrow(/mapping/i)
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical + ".native")).toBeNull()
    await db.query("UPDATE workspace_import_operations SET attempt_id=$1", [randomUUID()])
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBeNull()
  } finally {
    db.release()
    await pool.end()
  }
})

it.skipIf(!integrationDatabaseUrl)("fences an expired owner and retires its public object without a client retry", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  try {
    await db.query("CREATE TEMP TABLE workspace_import_operations (workspace_id uuid PRIMARY KEY, attempt_id uuid, epoch integer, phase text, lease_expires_at timestamp, updated_at timestamp, bundle_digest text)")
    await db.query("CREATE TEMP TABLE workspace_import_assets (attempt_id uuid, workspace_id uuid, logical_key text, physical_key text, backend text, state text, provider_id text, namespace_id text, updated_at timestamp)")
    const ws = randomUUID(), attempt = randomUUID()
    const key = "feedback/" + ws + "/" + attempt + "-" + "a".repeat(64)
    await db.query("INSERT INTO workspace_import_operations VALUES ($1,$2,3,'applying',now()-interval '1 minute',now(),'original')", [ws, attempt])
    await db.query("INSERT INTO workspace_import_assets VALUES ($1,$2,'attachment',$3,'feedback','reserved','blob','fixture',now())", [attempt, ws, key])
    const tx = { async $queryRawUnsafe<T>(sql: string, ...args: unknown[]) { return (await db.query(sql,args)).rows as T } }
    const remove = vi.fn(async () => {})
    const { sweepAbandonedAssets } = await import("@/lib/workspace-export/abandoned-assets")
    await sweepAbandonedAssets(tx, () => ({ provider: "blob", namespace: "fixture", remove }))
    expect(remove).toHaveBeenCalledWith(key)
    const op = (await db.query("SELECT * FROM workspace_import_operations")).rows[0]
    expect(op.epoch).toBeGreaterThan(3)
    expect(op.bundle_digest).toBe("original")
    expect(op.phase).not.toBe("rolled_back")
    expect((await db.query("SELECT state FROM workspace_import_assets")).rows[0].state).toBe("reserved")
  } finally {
    db.release()
    await pool.end()
  }
})
