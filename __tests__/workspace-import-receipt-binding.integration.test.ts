import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { expect, it } from "vitest"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

it.skipIf(!integrationDatabaseUrl)("binds a receipt once and replays only its scoped committed result", async () => {
  const pool = new Pool({ connectionString: integrationDatabaseUrl })
  const db = await pool.connect()
  try {
    await db.query(`CREATE TEMP TABLE workspace_import_receipts (
      receipt_digest text PRIMARY KEY, workspace_id uuid NOT NULL, organization_id uuid NOT NULL,
      user_id uuid NOT NULL, effective_nonce text NOT NULL, expires_at timestamp NOT NULL
    )`)
    await db.query(`CREATE TEMP TABLE workspace_import_operations (
      workspace_id uuid PRIMARY KEY, organization_id uuid NOT NULL, phase text NOT NULL, result_text text
    )`)
    const tx = {
      async $queryRawUnsafe<T>(sql: string, ...params: unknown[]) {
        return (await db.query(sql, params)).rows as T
      },
    }
    const { bindImportReceipt, readImportReceiptResult } = await import("@/lib/workspace-export/receipt-binding")
    const scope = { digest: "a".repeat(64), organizationId: randomUUID(), userId: randomUUID(), nonce: "first" }
    const workspaceId = randomUUID()
    const expiresAt = new Date(Date.now() + 60_000)
    await bindImportReceipt(tx, { ...scope, workspaceId, expiresAt })
    await bindImportReceipt(tx, { ...scope, workspaceId, expiresAt })
    await expect(bindImportReceipt(tx, { ...scope, nonce: "second", workspaceId, expiresAt })).rejects.toThrow(/binding/i)
    await expect(readImportReceiptResult(tx, scope)).resolves.toBeNull()
    const report = { workspaceId, slug: "recovered" }
    await db.query("INSERT INTO workspace_import_operations VALUES ($1, $2, 'committed', $3)", [workspaceId, scope.organizationId, JSON.stringify(report)])
    await expect(readImportReceiptResult(tx, scope)).resolves.toEqual(report)
    await expect(readImportReceiptResult(tx, { ...scope, userId: randomUUID() })).resolves.toBeNull()
    await expect(readImportReceiptResult(tx, { ...scope, nonce: "second" })).resolves.toBeNull()
    await db.query("UPDATE workspace_import_receipts SET expires_at = CURRENT_TIMESTAMP - interval '1 second'")
    await expect(readImportReceiptResult(tx, scope)).resolves.toBeNull()
  } finally {
    db.release()
    await pool.end()
  }
})
