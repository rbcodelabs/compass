import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { assertDocKindBackfill, backfillDocKinds } from "@/lib/migrations/doc-kind-backfill"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"
import { EXPECTED_COUNTS, REAL_DOC_ROWS } from "./helpers/doc-kind-real-paths"

/**
 * 117_doc_kind and 118_doc_kind_backfill through the registered runner (and the 118 hook directly) against throwaway schemas in the local
 * compass_e2e database. Skipped unless INTEGRATION_TEST_DATABASE_URL is set.
 */
const databaseUrl = integrationDatabaseUrl

function guard() {
  const url = new URL(databaseUrl!)
  if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
}

const DOCS_WITHOUT_KIND = (schema: string) =>
  `CREATE TABLE "${schema}".docs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, parent_id UUID, title VARCHAR(255) NOT NULL, doc_type VARCHAR(50) DEFAULT 'STANDARD', updated_at TIMESTAMP(3) NOT NULL DEFAULT '2026-01-01 00:00:00')`

/** Inserts the 49 real paths with their real parent/child links. Returns path -> id. */
async function seedRealDocs(pool: Pool, schema: string, workspaceId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const row of REAL_DOC_ROWS) {
    const slash = row.path.lastIndexOf("/")
    const parentId = slash === -1 ? null : ids.get(row.path.slice(0, slash)) ?? null
    const id = randomUUID()
    await pool.query(`INSERT INTO "${schema}".docs (id, workspace_id, parent_id, title) VALUES ($1,$2,$3,$4)`, [id, workspaceId, parentId, row.title])
    ids.set(row.path, id)
  }
  return ids
}

const kindsById = async (pool: Pool, schema: string) =>
  new Map((await pool.query<{ id: string; kind: string | null }>(`SELECT id, kind FROM "${schema}".docs`)).rows.map((row) => [row.id, row.kind]))

describe.skipIf(!databaseUrl)("117_doc_kind registered migration", () => {
  const schema = `dk117_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    guard()
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await pool.query(DOCS_WITHOUT_KIND(schema))
    await pool.query(`INSERT INTO "${schema}".docs (workspace_id, title) VALUES (gen_random_uuid(), 'legacy one'), (gen_random_uuid(), 'legacy two')`)
  })
  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("adds a nullable VARCHAR(30) kind column, leaves existing rows NULL, and reruns idempotently with one receipt", async () => {
    const first = await applyMigrations(pool, schema, "117_doc_kind")
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    const info = await pool.query("SELECT data_type, is_nullable, character_maximum_length, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='docs' AND column_name='kind'", [schema])
    expect(info.rows).toEqual([{ data_type: "character varying", is_nullable: "YES", character_maximum_length: 30, column_default: null }])
    const rows = await pool.query(`SELECT kind FROM "${schema}".docs`)
    expect(rows.rows).toHaveLength(2)
    for (const row of rows.rows) expect(row.kind).toBeNull()
    const again = await applyMigrations(pool, schema, "117_doc_kind")
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, ["117_doc_kind"])
    expect(receipts.rows).toHaveLength(1)
  })

  it("the SQL file itself is safe to execute again (IF NOT EXISTS)", async () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/117_doc_kind/migration.sql"), "utf-8")
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO "${schema}"`)
      await expect(client.query(sql)).resolves.toBeDefined()
      await expect(client.query(sql)).resolves.toBeDefined()
    } finally {
      client.release()
    }
  })
})

describe.skipIf(!databaseUrl)("118_doc_kind_backfill registered migration", () => {
  const schema = `dk118_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  const workspaceId = randomUUID()
  let created = false
  let ids: Map<string, string>
  let blockedId: string
  beforeAll(async () => {
    guard()
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await pool.query(DOCS_WITHOUT_KIND(schema))
    const applied = await applyMigrations(pool, schema, "117_doc_kind")
    expect(applied.status, JSON.stringify(await applied.json())).toBe(200)
    ids = await seedRealDocs(pool, schema, workspaceId)
    // A row the backfill would classify, blocked from updating: BEFORE UPDATE returning NULL silently skips the row.
    blockedId = ids.get("QA Reports/QA Report - Roadmap Gallery view - 2026-11-08 0715")!
    await pool.query(`CREATE FUNCTION "${schema}".skip_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`)
    await pool.query(`CREATE TRIGGER block_one BEFORE UPDATE ON "${schema}".docs FOR EACH ROW WHEN (OLD.id = '${blockedId}') EXECUTE FUNCTION "${schema}".skip_update()`)
  })
  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("fails its postcondition while a classifiable row is still NULL: error response, no completion receipt", async () => {
    const response = await applyMigrations(pool, schema, "118_doc_kind_backfill")
    expect(response.status).toBe(500)
    expect(JSON.stringify(await response.json())).toMatch(/118_doc_kind_backfill/)
    const finished = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, ["118_doc_kind_backfill"])
    expect(finished.rows).toHaveLength(0)
    // Everything except the blocked row was already written: the next run only has the rest to do.
    const kinds = await kindsById(pool, schema)
    expect(kinds.get(blockedId)).toBeNull()
    expect(kinds.get(ids.get("Decisions/ADR - Compass as a Geode Sync Provider")!)).toBe("ADR")
  })

  it("resumes once unblocked: classifies exactly the expected rows, leaves uncertain ones NULL, and records one receipt", async () => {
    await pool.query(`DROP TRIGGER block_one ON "${schema}".docs`)
    const response = await applyMigrations(pool, schema, "118_doc_kind_backfill")
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    const kinds = await kindsById(pool, schema)
    for (const row of REAL_DOC_ROWS) expect(kinds.get(ids.get(row.path)!), row.path).toBe(row.expected)
    const tally = { ADR: 0, QA_REPORT: 0, DESIGN: 0, NOTE: 0, unset: 0 }
    for (const kind of kinds.values()) tally[(kind ?? "unset") as keyof typeof tally] += 1
    expect(tally).toEqual({ ADR: EXPECTED_COUNTS.ADR, QA_REPORT: EXPECTED_COUNTS.QA_REPORT, DESIGN: EXPECTED_COUNTS.DESIGN, NOTE: 0, unset: EXPECTED_COUNTS.unset })
    const finished = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, ["118_doc_kind_backfill"])
    expect(finished.rows).toHaveLength(1)
  })

  it("does not move updated_at: Recent ordering is untouched by the backfill", async () => {
    const moved = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".docs WHERE updated_at <> '2026-01-01 00:00:00'`)
    expect(moved.rows[0].n).toBe(0)
  })
})

describe.skipIf(!databaseUrl)("118 hook behaviour", () => {
  const schema = `dk118h_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const workspaceId = randomUUID()
  let created = false
  beforeAll(async () => {
    guard()
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    await pool.query(DOCS_WITHOUT_KIND(schema))
    await pool.query(`ALTER TABLE "${schema}".docs ADD COLUMN kind VARCHAR(30)`)
  })
  afterAll(async () => {
    try {
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  })

  const run = async (options: { batchSize?: number } = {}) => {
    const client = await pool.connect()
    try {
      return await backfillDocKinds(client, schema, [], options)
    } finally {
      client.release()
    }
  }

  it("is idempotent: a second run changes nothing", async () => {
    await pool.query(`DELETE FROM "${schema}".docs`)
    const ids = await seedRealDocs(pool, schema, workspaceId)
    expect(await run()).toBe(EXPECTED_COUNTS.ADR + EXPECTED_COUNTS.QA_REPORT + EXPECTED_COUNTS.DESIGN)
    const after = await kindsById(pool, schema)
    expect(await run()).toBe(0)
    expect(await kindsById(pool, schema)).toEqual(after)
    expect(after.get(ids.get("Specs/Artifact templates v1")!)).toBeNull()
  })

  it("never overwrites a kind that is already set, even when the classifier disagrees", async () => {
    await pool.query(`DELETE FROM "${schema}".docs`)
    const ids = await seedRealDocs(pool, schema, workspaceId)
    const adr = ids.get("Decisions/ADR - Compass as a Geode Sync Provider")!
    const unclassifiable = ids.get("Next steps")!
    await pool.query(`UPDATE "${schema}".docs SET kind='NOTE' WHERE id=$1`, [adr])
    await pool.query(`UPDATE "${schema}".docs SET kind='DESIGN' WHERE id=$1`, [unclassifiable])
    await run()
    const kinds = await kindsById(pool, schema)
    expect(kinds.get(adr)).toBe("NOTE")
    expect(kinds.get(unclassifiable)).toBe("DESIGN")
    expect(kinds.get(ids.get("Architecture/ADR-0018 Tracked Entities")!)).toBe("ADR")
  })

  it("terminates and stays correct with a tiny batch size, though most rows can never be classified", async () => {
    await pool.query(`DELETE FROM "${schema}".docs`)
    const ids = await seedRealDocs(pool, schema, workspaceId)
    expect(await run({ batchSize: 2 })).toBe(EXPECTED_COUNTS.ADR + EXPECTED_COUNTS.QA_REPORT + EXPECTED_COUNTS.DESIGN)
    const kinds = await kindsById(pool, schema)
    for (const row of REAL_DOC_ROWS) expect(kinds.get(ids.get(row.path)!), row.path).toBe(row.expected)
  })

  it("classifies a SPEC doc by the same title and parent rules, no differently from other docs", async () => {
    await pool.query(`DELETE FROM "${schema}".docs`)
    const parent = randomUUID()
    await pool.query(`INSERT INTO "${schema}".docs (id, workspace_id, title, doc_type) VALUES ($1,$2,'QA Reports','STANDARD')`, [parent, workspaceId])
    await pool.query(`INSERT INTO "${schema}".docs (workspace_id, parent_id, title, doc_type) VALUES ($1,$2,'Plain child of QA Reports','SPEC'), ($1,NULL,'Spec - Checkout','SPEC'), ($1,NULL,'ADR - A spec-typed ADR','SPEC')`, [workspaceId, parent])
    await run()
    const rows = await pool.query<{ title: string; kind: string | null }>(`SELECT title, kind FROM "${schema}".docs`)
    const byTitle = new Map(rows.rows.map((row) => [row.title, row.kind]))
    expect(byTitle.get("Plain child of QA Reports")).toBe("QA_REPORT")
    expect(byTitle.get("Spec - Checkout")).toBeNull()
    expect(byTitle.get("ADR - A spec-typed ADR")).toBe("ADR")
  })

  it("reads a dangling parent_id as no parent (title rules only) and ignores a parent in another workspace", async () => {
    await pool.query(`DELETE FROM "${schema}".docs`)
    const otherWorkspaceParent = randomUUID()
    await pool.query(`INSERT INTO "${schema}".docs (id, workspace_id, title) VALUES ($1,$2,'QA Reports')`, [otherWorkspaceParent, randomUUID()])
    await pool.query(`INSERT INTO "${schema}".docs (workspace_id, parent_id, title) VALUES ($1,gen_random_uuid(),'Orphan note'), ($1,gen_random_uuid(),'ADR - Orphan decision'), ($1,$2,'Cross workspace child')`, [workspaceId, otherWorkspaceParent])
    await run()
    const rows = await pool.query<{ title: string; kind: string | null }>(`SELECT title, kind FROM "${schema}".docs WHERE workspace_id=$1`, [workspaceId])
    const byTitle = new Map(rows.rows.map((row) => [row.title, row.kind]))
    expect(byTitle.get("Orphan note")).toBeNull()
    expect(byTitle.get("ADR - Orphan decision")).toBe("ADR")
    expect(byTitle.get("Cross workspace child")).toBeNull()
  })

  it("the postcondition passes once every classifiable row has a kind, and refuses when one does not", async () => {
    await pool.query(`DELETE FROM "${schema}".docs`)
    await seedRealDocs(pool, schema, workspaceId)
    const client = await pool.connect()
    try {
      await expect(assertDocKindBackfill(client, schema)).rejects.toThrow(/118_doc_kind_backfill/)
      await backfillDocKinds(client, schema, [])
      await expect(assertDocKindBackfill(client, schema)).resolves.toBeUndefined()
    } finally {
      client.release()
    }
  })

  it("refuses to run before 117 has added the column", async () => {
    const bare = `dk118b_${randomUUID().replaceAll("-", "")}`
    await pool.query(`CREATE SCHEMA "${bare}"`)
    try {
      await pool.query(DOCS_WITHOUT_KIND(bare))
      const client = await pool.connect()
      try {
        await expect(backfillDocKinds(client, bare, [])).rejects.toThrow(/117_doc_kind/)
      } finally {
        client.release()
      }
    } finally {
      await pool.query(`DROP SCHEMA "${bare}" CASCADE`)
    }
  })
})
