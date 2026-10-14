import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { assertCardSortRoundsMigration } from "@/lib/migrations/card-sort-rounds"
import { applyMigrations } from "@/lib/migrations/runner"

/**
 * 065 through the registered runner, on a throwaway schema of this suite's own.
 *
 * Applying the schema with `prisma db push` is not a substitute: push invents its
 * own index names, so it would happily produce working tables while leaving the
 * `idx_card_sort_*` names the postcondition assertion actually looks for absent.
 * The only way to know the migration and its assertion agree is to run both.
 *
 * Set CARD_SORT_DATABASE_URL to the local compass_e2e database to enable. The
 * guard below is what keeps that var from ever pointing anywhere else — this
 * suite creates and drops schemas, which must never happen against DSQL.
 */
const databaseUrl = process.env.CARD_SORT_DATABASE_URL

describe.skipIf(!databaseUrl)("065 card sort migration through the registered runner", () => {
  const schema = `card_sort_test_${randomUUID().replaceAll("-", "")}`
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
    // DATABASE_URL being set is the runner's "local PostgreSQL" signal: it is
    // what makes the runner rewrite `INDEX ASYNC` to plain `INDEX` and skip the
    // DSQL job-wait. Restored in afterAll.
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

  it("creates both tables with the named indexes and earns exactly one receipt", async () => {
    const result = await applyMigrations(pool, schema, "067_card_sort_rounds")
    const body = await result.json()
    expect(body.error).toBeUndefined()
    expect(result.status).toBe(200)

    // The runner already ran this postcondition before writing its receipt.
    // Asserting it again here proves the receipt was earned, not assumed.
    const client = await pool.connect()
    try {
      await assertCardSortRoundsMigration(client, schema)
    } finally {
      client.release()
    }

    // The latest-wins constraint, verified as a live database constraint rather
    // than a Prisma declaration. Two proposals from one person on one object in
    // one round must be impossible.
    const roundId = randomUUID()
    const userId = randomUUID()
    const objectId = randomUUID()
    await pool.query(
      `INSERT INTO "${schema}".card_sort_rounds(id,workspace_id,name,object_type,field_definition_id,created_by_id) VALUES ($1,$2,'Q4 MoSCoW','OPPORTUNITY',$3,$4)`,
      [roundId, randomUUID(), randomUUID(), userId]
    )
    await pool.query(
      `INSERT INTO "${schema}".card_sort_proposals(id,round_id,user_id,object_id,proposed_value,from_value) VALUES ($1,$2,$3,$4,'should_do','must_do')`,
      [randomUUID(), roundId, userId, objectId]
    )
    await expect(
      pool.query(
        `INSERT INTO "${schema}".card_sort_proposals(id,round_id,user_id,object_id,proposed_value,from_value) VALUES ($1,$2,$3,$4,'could_do','must_do')`,
        [randomUUID(), roundId, userId, objectId]
      )
    ).rejects.toThrow(/duplicate key|unique/i)

    // A proposal on a previously unset object: from_value NULL is the state the
    // assertion's nullability check exists to protect.
    await pool.query(
      `INSERT INTO "${schema}".card_sort_proposals(id,round_id,user_id,object_id,proposed_value,from_value) VALUES ($1,$2,$3,$4,'must_do',NULL)`,
      [randomUUID(), roundId, randomUUID(), objectId]
    )
    const unset = await pool.query<{ from_value: string | null }>(
      `SELECT from_value FROM "${schema}".card_sort_proposals WHERE from_value IS NULL`
    )
    expect(unset.rows).toHaveLength(1)

    // state defaults to OPEN, so a round is never accidentally born revealed.
    const state = await pool.query<{ state: string; revealed_at: Date | null }>(
      `SELECT state, revealed_at FROM "${schema}".card_sort_rounds WHERE id = $1`,
      [roundId]
    )
    expect(state.rows[0].state).toBe("OPEN")
    expect(state.rows[0].revealed_at).toBeNull()

    // IF NOT EXISTS makes the SQL a no-op on rerun; the receipt count is what
    // proves the runner agrees and does not record a second application.
    const repeated = await applyMigrations(pool, schema, "067_card_sort_rounds")
    expect(repeated.status).toBe(200)
    const receipts = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name = '067_card_sort_rounds' AND finished_at IS NOT NULL`
    )
    expect(receipts.rows[0].count).toBe(1)
  })

  it("fails its postcondition when the unique index is merely non-unique", async () => {
    // Guards the guard: a name-only check would pass here. If someone
    // "simplifies" the assertion by dropping the indisunique test, this fails.
    const scratch = `${schema}_nonunique`
    await pool.query(`CREATE SCHEMA "${scratch}"`)
    try {
      await applyMigrations(pool, scratch, "067_card_sort_rounds")
      await pool.query(`DROP INDEX "${scratch}".idx_card_sort_proposals_round_user_object`)
      await pool.query(
        `CREATE INDEX idx_card_sort_proposals_round_user_object ON "${scratch}".card_sort_proposals (round_id, user_id, object_id)`
      )
      const client = await pool.connect()
      try {
        await expect(assertCardSortRoundsMigration(client, scratch)).rejects.toThrow(/not UNIQUE/)
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${scratch}" CASCADE`)
    }
  })
})
