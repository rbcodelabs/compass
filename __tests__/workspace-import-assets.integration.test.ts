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
      attempt_id uuid, workspace_id uuid, logical_key text, physical_key text, backend text, state text,
      updated_at timestamp DEFAULT now(), PRIMARY KEY(attempt_id,logical_key))`)
    const owner = { attemptId: randomUUID(), workspaceId: randomUUID(), epoch: 1 }
    const logical = "docs/" + owner.workspaceId + "/images/chart.png"
    await db.query("INSERT INTO workspace_import_operations VALUES ($1,$2,1,'applying', now()+interval '1 minute',now())", [owner.workspaceId,owner.attemptId])
    const tx = { async $queryRawUnsafe<T>(sql: string, ...args: unknown[]) { return (await db.query(sql,args)).rows as T } }
    const { reserveImportAsset, verifyImportAsset, lookupImportAsset } = await import("@/lib/workspace-export/asset-journal")
    const key = await reserveImportAsset(tx, owner, "artifact", logical)
    expect(key).toContain(owner.attemptId)
    expect((await db.query("SELECT state FROM workspace_import_assets")).rows[0].state).toBe("reserved")
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBeNull()
    await verifyImportAsset(tx, owner, "artifact", logical, key)
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBeNull()
    await db.query("UPDATE workspace_import_operations SET phase='committed'")
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBe(key)
    await db.query("UPDATE workspace_import_operations SET attempt_id=$1", [randomUUID()])
    expect(await lookupImportAsset(tx, owner.workspaceId, "artifact", logical)).toBeNull()
  } finally {
    db.release()
    await pool.end()
  }
})
