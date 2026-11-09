import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertCustomFieldInheritanceRulesMigration } from "@/lib/migrations/custom-field-inheritance-rules"
import { applyMigrations } from "@/lib/migrations/runner"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 113_custom_field_inheritance_rules through the registered runner on plain Postgres, on a throwaway schema of this
 * suite's own, after every earlier migration has been replayed. This proves the plain-Postgres path (the runner rewrites
 * INDEX ASYNC to INDEX); it cannot prove Aurora DSQL, which is covered by the SQL-shape assertions in
 * custom-field-inheritance-migration.test.ts.
 *
 * Set CUSTOM_FIELD_INHERITANCE_DATABASE_URL to the local compass_e2e database to enable. The guard keeps it from ever
 * pointing anywhere else: this suite creates and drops schemas, which must never happen against DSQL or a shared database.
 */
const databaseUrl = process.env.CUSTOM_FIELD_INHERITANCE_DATABASE_URL
const NAME = "113_custom_field_inheritance_rules"

describe.skipIf(!databaseUrl)("custom field inheritance rules migration on plain Postgres", () => {
  const schema = `cfir_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let owned = false

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
  }, 120_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("replays every migration, earns the 113 receipt, and the postcondition holds", async () => {
    const result = await replayAllMigrations(pool, schema)
    expect((await result.json()).error).toBeUndefined()
    const receipts = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [NAME])
    expect(receipts.rows).toHaveLength(1)
    const client = await pool.connect()
    try {
      await assertCustomFieldInheritanceRulesMigration(client, schema)
    } finally {
      client.release()
    }
  }, 900_000)

  it("created a table without any foreign key, with the unique indexes enforcing the ADR's constraints", async () => {
    const foreignKeys = await pool.query(
      `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'custom_field_inheritance_rules' AND c.contype = 'f'`,
      [schema],
    )
    expect(foreignKeys.rows).toHaveLength(0)

    const ws = randomUUID()
    const target = randomUUID()
    const insert = (source: string, priority: number) =>
      pool.query(
        `INSERT INTO "${schema}".custom_field_inheritance_rules (workspace_id, target_object_type, target_field_id, source_object_type, source_field_id, priority)
         VALUES ($1, 'ROADMAP_ITEM', $2, 'OPPORTUNITY', $3, $4)`,
        [ws, target, source, priority],
      )
    const sourceA = randomUUID()
    await insert(sourceA, 0)
    await expect(insert(randomUUID(), 0)).rejects.toThrow(/duplicate key/) // (workspace, target, priority)
    await expect(insert(sourceA, 1)).rejects.toThrow(/duplicate key/) // (workspace, target, source)
    await insert(randomUUID(), 1)
    const row = await pool.query(`SELECT enabled, source FROM "${schema}".custom_field_inheritance_rules WHERE workspace_id = $1 AND priority = 0`, [ws])
    expect(row.rows[0]).toEqual({ enabled: true, source: "UI" })
  })

  it("is idempotent: running it again changes nothing and keeps a single receipt", async () => {
    const before = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".custom_field_inheritance_rules`)
    const again = await applyMigrations(pool, schema, NAME)
    expect(again.status).toBe(200)
    const after = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".custom_field_inheritance_rules`)
    expect(after.rows[0].n).toBe(before.rows[0].n)
    const receipts = await pool.query(`SELECT 1 FROM "${schema}"._prisma_migrations WHERE migration_name = $1`, [NAME])
    expect(receipts.rows).toHaveLength(1)

    const client = await pool.connect()
    try {
      // Re-run the raw SQL directly: every statement is IF NOT EXISTS, so a second pass is a no-op (indexes rewritten like the runner does).
      const { readFileSync } = await import("node:fs")
      const sql = readFileSync(`${process.cwd()}/prisma/migrations/${NAME}/migration.sql`, "utf-8").replace(/\bINDEX ASYNC\b/gi, "INDEX")
      await client.query(`SET search_path TO "${schema}"`)
      for (const statement of sql.split(";").map((s) => s.replace(/--.*$/gm, "").trim()).filter(Boolean)) await client.query(statement)
      await assertCustomFieldInheritanceRulesMigration(client, schema)
    } finally {
      client.release()
    }
  })
})
