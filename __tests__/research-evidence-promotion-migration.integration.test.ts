import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

/**
 * ADR-0012 step 5. Exercises 052 against a real PostgreSQL schema the test owns
 * outright, exactly as the 051 integration test does — so the SQL is proven to
 * parse and to be genuinely re-runnable, not merely pattern-matched.
 *
 * Opt in with RESEARCH_EVIDENCE_PROMOTION_DATABASE_URL pointing at the local
 * compass_e2e database. Skipped by default so the suite stays hermetic.
 */
const databaseUrl = process.env.RESEARCH_EVIDENCE_PROMOTION_DATABASE_URL
describe.skipIf(!databaseUrl)("052 canonical migration on an owned local schema", () => {
  const schema = `research_evidence_promotion_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (url.protocol !== "postgresql:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Requires local compass_e2e without schema override")
    }
    // DATABASE_URL is the runner's local-mode signal: it rewrites INDEX ASYNC to
    // plain INDEX, since ASYNC is DSQL-only grammar.
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    // The pre-existing, already-populated table 052 adds columns to. A row is
    // seeded so the additive ALTERs are proven not to rewrite or reject
    // existing data — the DSQL constraint the migration is written around.
    await pool.query(`CREATE TABLE "${schema}".evidence (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      workspace_id UUID NOT NULL,
      source_type VARCHAR(50) NOT NULL,
      excerpt TEXT NOT NULL,
      confidence VARCHAR(50) NOT NULL DEFAULT 'medium'
    )`)
    await pool.query(`INSERT INTO "${schema}".evidence (workspace_id, source_type, excerpt) VALUES (gen_random_uuid(), 'feedback', 'pre-existing row')`)
  })

  afterAll(async () => {
    try { if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`) }
    finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  const migration = "052_research_evidence_promotion"

  it("applies additively, leaves existing rows intact, and replays with one receipt", async () => {
    const response = await applyMigrations(pool, schema, migration)
    const body = await response.json()
    expect(body, JSON.stringify(body)).not.toHaveProperty("error")
    expect(response.status).toBe(200)

    const evidenceColumns = await pool.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='evidence' AND column_name IN ('research_synthesis_id','finding_key') ORDER BY column_name",
      [schema],
    )
    expect(evidenceColumns.rows).toEqual([
      { column_name: "finding_key", data_type: "character", is_nullable: "YES", column_default: null },
      { column_name: "research_synthesis_id", data_type: "uuid", is_nullable: "YES", column_default: null },
    ])

    const preserved = await pool.query(`SELECT excerpt, research_synthesis_id, finding_key FROM "${schema}".evidence`)
    expect(preserved.rows).toEqual([{ excerpt: "pre-existing row", research_synthesis_id: null, finding_key: null }])

    const sourceColumns = await pool.query(
      "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='evidence_research_sources' ORDER BY column_name",
      [schema],
    )
    expect(sourceColumns.rows).toEqual([
      { column_name: "created_at", data_type: "timestamp without time zone", is_nullable: "NO" },
      { column_name: "evidence_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "research_attachment_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "research_turn_id", data_type: "uuid", is_nullable: "NO" },
    ])

    // No foreign keys: DSQL has none, so nothing here may depend on one.
    const constraints = await pool.query(
      "SELECT constraint_type FROM information_schema.table_constraints WHERE table_schema=$1 AND table_name='evidence_research_sources'",
      [schema],
    )
    expect(constraints.rows.map(row => row.constraint_type)).not.toContain("FOREIGN KEY")

    const indexes = await pool.query(
      "SELECT c.relname AS name, i.indisunique, i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[]) ORDER BY c.relname",
      [schema, ["idx_evidence_research_sources_evidence_turn", "idx_evidence_research_sources_turn", "idx_evidence_research_synthesis", "idx_evidence_workspace_finding_key"]],
    )
    expect(indexes.rows).toEqual([
      { name: "idx_evidence_research_sources_evidence_turn", indisunique: true, indisvalid: true },
      { name: "idx_evidence_research_sources_turn", indisunique: false, indisvalid: true },
      { name: "idx_evidence_research_synthesis", indisunique: false, indisvalid: true },
      { name: "idx_evidence_workspace_finding_key", indisunique: true, indisvalid: true },
    ])

    // Re-runnable: a second apply is a clean no-op and does not write a second
    // completion receipt.
    const replay = await applyMigrations(pool, schema, migration)
    expect(replay.status).toBe(200)
    const receipts = await pool.query(`SELECT count(*)::int AS count FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [migration])
    expect(receipts.rows[0].count).toBe(1)
  }, 30_000)

  it("enforces the idempotency key per workspace while leaving unpromoted rows unconstrained", async () => {
    const workspace = randomUUID()
    const other = randomUUID()
    const key = "a".repeat(64)
    const insert = (ws: string, findingKey: string | null) =>
      pool.query(`INSERT INTO "${schema}".evidence (workspace_id, source_type, excerpt, finding_key) VALUES ($1,'interview','x',$2)`, [ws, findingKey])

    await insert(workspace, key)
    // Same key, different workspace: allowed. A global unique here would let one
    // tenant's write fail because of a row in another tenant it cannot see.
    await expect(insert(other, key)).resolves.toBeTruthy()
    // Same key, same workspace: this is what makes promotion converge.
    await expect(insert(workspace, key)).rejects.toThrow(/duplicate key/i)
    // NULLs are distinct, so every add_evidence row stays unconstrained.
    await expect(insert(workspace, null)).resolves.toBeTruthy()
    await expect(insert(workspace, null)).resolves.toBeTruthy()
  }, 30_000)
})
