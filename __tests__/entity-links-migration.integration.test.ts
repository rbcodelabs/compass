import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertEntityLinksMigration } from "@/lib/migrations/entity-links"
import { applyMigrations } from "@/lib/migrations/runner"

/**
 * 091 through the registered runner, on a throwaway schema of this suite's own.
 *
 * Set ENTITY_LINKS_DATABASE_URL to the local compass_e2e database to enable. The guard below
 * keeps that var from ever pointing anywhere else: this suite creates and drops schemas, which
 * must never happen against DSQL or a shared database.
 */
const databaseUrl = process.env.ENTITY_LINKS_DATABASE_URL
const MIGRATION = "091_entity_links"

describe.skipIf(!databaseUrl)("091 entity links migration through the registered runner", () => {
  const schema = `entity_links_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let owned = false

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    // DATABASE_URL being set is the runner's "plain PostgreSQL" signal: it rewrites
    // `INDEX ASYNC` to plain `INDEX` and skips the DSQL job-wait.
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
  })

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const insert = (workspaceId: string, linkType: string, fromId: string, toId: string) =>
    pool.query(
      `INSERT INTO "${schema}".entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id) VALUES ($1,$2,'OPPORTUNITY',$3,'OBJECTIVE',$4)`,
      [workspaceId, linkType, fromId, toId]
    )

  it("creates the table and indexes, earns one receipt, rejects duplicate pairs, and reruns as a no-op", async () => {
    const result = await applyMigrations(pool, schema, MIGRATION)
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    const client = await pool.connect()
    try {
      await assertEntityLinksMigration(client, schema)
    } finally {
      client.release()
    }

    const workspaceId = randomUUID()
    const fromId = randomUUID()
    const toId = randomUUID()
    await insert(workspaceId, "OPPORTUNITY_OBJECTIVE", fromId, toId)
    const row = await pool.query<{ origin: string; source: string; created_by_id: string | null; attrs: string | null }>(
      `SELECT origin, source, created_by_id, attrs FROM "${schema}".entity_links WHERE from_id = $1`,
      [fromId]
    )
    expect(row.rows[0]).toEqual({ origin: "DIRECT", source: "UI", created_by_id: null, attrs: null })

    // The same ordered pair and link type is rejected; a different link type or direction is not.
    await expect(insert(workspaceId, "OPPORTUNITY_OBJECTIVE", fromId, toId)).rejects.toThrow(/duplicate key|unique/i)
    await insert(workspaceId, "OTHER_LINK", fromId, toId)
    await insert(workspaceId, "OPPORTUNITY_OBJECTIVE", toId, fromId)

    // IF NOT EXISTS makes the SQL a no-op on rerun; the data survives and no second receipt is recorded.
    const repeated = await applyMigrations(pool, schema, MIGRATION)
    expect(repeated.status).toBe(200)
    const receipts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`,
      [MIGRATION]
    )
    expect(receipts.rows[0].count).toBe(1)
    const rows = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "${schema}".entity_links`)
    expect(rows.rows[0].count).toBe(3)
  })

  it("fails its postcondition when the pair index is merely non-unique", async () => {
    // Guards the guard: a name-only check would pass here.
    const scratch = `${schema}_nonunique`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      await applyMigrations(pool, scratch, MIGRATION)
      await pool.query(`DROP INDEX "${scratch}".idx_entity_links_pair`)
      await pool.query(`CREATE INDEX idx_entity_links_pair ON "${scratch}".entity_links (from_id, link_type, to_id)`)
      const client = await pool.connect()
      try {
        await expect(assertEntityLinksMigration(client, scratch)).rejects.toThrow(/not ready or has drifted/)
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })
})
