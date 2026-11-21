import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { expect, it, vi } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

vi.mock("@/lib/schema", () => ({ getActiveSchema: () => "pg_temp" }))

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

it.skipIf(!integrationDatabaseUrl)("publishes a recorded report only for the live applying attempt", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  try {
    await db.query(`CREATE TEMP TABLE workspace_import_operations (
      workspace_id uuid PRIMARY KEY, organization_id uuid, attempt_id uuid, epoch integer DEFAULT 1,
      phase text, lease_expires_at timestamptz, result_text text, updated_at timestamptz
    )`)
    const tx = { async $queryRawUnsafe<T>(sql: string, ...args: unknown[]) { return (await db.query(sql, args)).rows as T } }
    const { startImportOperation, commitImportReport } = await import("@/lib/workspace-export/operation")
    const workspaceId = randomUUID()
    const organizationId = randomUUID()
    const owner = await startImportOperation(tx, workspaceId, organizationId)
    await expect(startImportOperation(tx, workspaceId, organizationId)).rejects.toThrow(/in progress/i)
    const report = { workspaceId, slug: "copy", name: "Copy", alreadyImported: false, counts: {}, warnings: [],
      usersMatched: 0, usersFallbackToImporter: 0, referencesCleared: 0, blobsCopied: 0 }
    await expect(commitImportReport(tx, { ...owner, epoch: owner.epoch + 1 }, report)).rejects.toThrow(/ownership changed/i)
    await commitImportReport(tx, owner, report)
    const { rows } = await db.query("SELECT phase, result_text FROM workspace_import_operations")
    expect(rows[0].phase).toBe("committed")
    expect(JSON.parse(rows[0].result_text)).toEqual(report)
  } finally {
    db.release()
    await pool.end()
  }
})

it.skipIf(!integrationDatabaseUrl)("acquires the operation in the application schema with an empty search path", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  const schema = "import_fixture_" + randomUUID().replaceAll("-", "")
  try {
    await db.query("BEGIN")
    await db.query(`CREATE SCHEMA "${schema}"`)
    await db.query(`CREATE TABLE "${schema}".workspace_import_operations (
      workspace_id uuid PRIMARY KEY, organization_id uuid, attempt_id uuid, epoch integer DEFAULT 1,
      phase text, lease_expires_at timestamp, updated_at timestamp)`)
    await db.query("SET LOCAL search_path TO pg_catalog")
    const { startImportOperation } = await import("@/lib/workspace-export/operation")
    const tx = { async $queryRawUnsafe<T>(sql: string, ...args: unknown[]) { return (await db.query(sql, args)).rows as T } }
    const workspaceId = randomUUID()
    expect((await startImportOperation(tx, workspaceId, randomUUID(), schema)).workspaceId).toBe(workspaceId)
  } finally {
    await db.query("ROLLBACK")
    db.release()
    await pool.end()
  }
})

it.skipIf(!integrationDatabaseUrl)("renews only an unexpired lease owned by the current attempt", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  try {
    await db.query(`CREATE TEMP TABLE workspace_import_operations (
      workspace_id uuid PRIMARY KEY, attempt_id uuid, epoch integer, phase text, updated_at timestamp, lease_expires_at timestamp)`)
    const owner = { workspaceId: randomUUID(), attemptId: randomUUID(), epoch: 3 }
    await db.query("INSERT INTO workspace_import_operations VALUES ($1,$2,3,'applying',now(),now()+interval '20 seconds')", [owner.workspaceId, owner.attemptId])
    const { renewImportOperation } = await import("@/lib/workspace-export/operation")
    const tx = { async $queryRawUnsafe<T>(sql: string, ...args: unknown[]) { return (await db.query(sql, args)).rows as T } }
    await renewImportOperation(tx, owner, "applying")
    expect((await db.query("SELECT lease_expires_at > now()+interval '4 minutes' AS renewed FROM workspace_import_operations")).rows[0].renewed).toBe(true)
    await expect(renewImportOperation(tx, { ...owner, epoch: 2 }, "applying")).rejects.toThrow(/ownership changed/i)
    await db.query("UPDATE workspace_import_operations SET lease_expires_at = now()-interval '1 second'")
    await expect(renewImportOperation(tx, owner, "applying")).rejects.toThrow(/ownership changed/i)
  } finally {
    db.release()
    await pool.end()
  }
})
