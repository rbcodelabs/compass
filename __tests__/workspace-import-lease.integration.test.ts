import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { expect, it } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

it.skipIf(!integrationDatabaseUrl)("rejects a stale import mutation after database-time takeover", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  try {
    await db.query(`CREATE TEMP TABLE workspace_import_operations (
      workspace_id uuid PRIMARY KEY, attempt_id uuid NOT NULL, epoch integer NOT NULL,
      phase text NOT NULL, lease_expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
    )`)
    const workspaceId = randomUUID()
    const original = { workspaceId, attemptId: randomUUID(), epoch: 1 }
    const replacement = { workspaceId, attemptId: randomUUID(), epoch: 2 }
    await db.query(`INSERT INTO workspace_import_operations VALUES
      ($1, $2, 1, 'applying', clock_timestamp() - interval '1 minute', clock_timestamp())`,
    [workspaceId, original.attemptId])
    const { fenceImportLease, takeOverImportLease } = await import("@/lib/workspace-export/lease")
    expect(await takeOverImportLease(db, original, replacement.attemptId, 60_000)).toEqual(replacement)
    await expect(fenceImportLease(db, original, "applying")).rejects.toThrow(/ownership changed/i)
    await expect(fenceImportLease(db, replacement, "recovering")).resolves.toBeUndefined()
    expect(await takeOverImportLease(db, replacement, randomUUID(), 60_000)).toBeNull()
  } finally {
    db.release()
    await pool.end()
  }
})
