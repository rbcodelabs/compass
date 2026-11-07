import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import type { AppPrismaClient } from "@/lib/db"
import { applyMigrations } from "@/lib/migrations/runner"
import { getPublishedDoc, listPublishedDocs } from "@/lib/portal-docs/service"
import { createWidget } from "@/lib/portal-home/schema"
import { loadHomeLayout, loadPublishedHome, publishDraft, saveDraft } from "@/lib/portal-home/service"

// Runs 113 and 114 through the registered runner against a throwaway schema in the local compass_e2e database.
// Skipped unless UPDATES_TEST_DATABASE_URL is set (same convention as the 074/075 tests).
const databaseUrl = process.env.UPDATES_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)("doc publishing + portal home template registered migrations", () => {
  const schema = `dpt_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
    // Populated tables: existing rows must come through untouched, with NULL in every new column.
    await pool.query(`CREATE TABLE "${schema}".docs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), title VARCHAR(255) NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".docs (title) VALUES ('legacy one'), ('legacy two')`)
    await pool.query(`CREATE TABLE "${schema}".portal_home_layouts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL)`)
    await pool.query(`INSERT INTO "${schema}".portal_home_layouts (workspace_id) VALUES (gen_random_uuid())`)
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

  it.each([
    ["113_doc_publishing", "docs", ["published_at", "published_by_id"]],
    ["114_portal_home_template", "portal_home_layouts", ["draft_template", "published_template"]],
  ] as const)("%s adds nullable columns, leaves existing rows NULL, and reruns idempotently with one receipt", async (name, table, columns) => {
    const first = await applyMigrations(pool, schema, name)
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    const info = await pool.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name = ANY($3) ORDER BY column_name", [schema, table, [...columns]])
    expect(info.rows).toEqual([...columns].sort().map((column_name) => ({ column_name, is_nullable: "YES" })))
    const rows = await pool.query(`SELECT ${columns.join(", ")} FROM "${schema}".${table}`)
    for (const row of rows.rows) for (const column of columns) expect(row[column]).toBeNull()
    const again = await applyMigrations(pool, schema, name)
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [name])
    expect(receipts.rows).toHaveLength(1)
  })
})

// Real Prisma against a database that has NOT applied 113: the public doc reads must fail closed (nothing is
// published yet), not throw. This also proves the driver adapter surfaces a missing column as P2022.
describe.skipIf(!databaseUrl)("public doc reads before migration 113 is applied", () => {
  const schema = `dpre_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  let prisma: PrismaClient
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE "${schema}".docs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, title VARCHAR(255) NOT NULL, content TEXT, storage_provider VARCHAR(20), updated_at TIMESTAMP(3) NOT NULL DEFAULT now())`)
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
  })
  afterAll(async () => {
    try {
      await prisma?.$disconnect()
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
    }
  })

  it("returns an empty list and null instead of throwing", async () => {
    const workspaceId = randomUUID()
    const docId = randomUUID()
    await pool.query(`INSERT INTO "${schema}".docs (id, workspace_id, title) VALUES ($1, $2, 'private')`, [docId, workspaceId])
    const app = prisma as unknown as AppPrismaClient
    expect(await listPublishedDocs(app, workspaceId)).toEqual([])
    expect(await getPublishedDoc(app, workspaceId, docId)).toBeNull()
  })
})

// Real Prisma, 074 + 114 applied: the template round-trips draft -> publish -> customer read, and a draft
// template never leaks to the customer read before it is published.
describe.skipIf(!databaseUrl)("portal home template round trip after migration 114", () => {
  const schema = `ptpl_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let prisma: PrismaClient
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    for (const name of ["074_portal_home_layout", "114_portal_home_template"]) {
      const response = await applyMigrations(pool, schema, name)
      expect(response.status, JSON.stringify(await response.json())).toBe(200)
    }
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
  })
  afterAll(async () => {
    try {
      await prisma?.$disconnect()
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("saves the template with the draft, publishes it, and keeps the draft template private until then", async () => {
    const app = prisma as unknown as AppPrismaClient
    const workspaceId = randomUUID()
    const widget = createWidget("rich_text", 0)

    await saveDraft(app, workspaceId, [widget], "bento")
    expect(await loadHomeLayout(app, workspaceId)).toMatchObject({ draftTemplate: "bento", publishedTemplate: "editorial" })
    await saveDraft(app, workspaceId, [widget]) // widgets-only autosave keeps the template
    expect((await loadHomeLayout(app, workspaceId)).draftTemplate).toBe("bento")
    expect(await loadPublishedHome(app, workspaceId)).toEqual({ widgets: null, template: "editorial" })

    await publishDraft(app, workspaceId, randomUUID())
    expect(await loadPublishedHome(app, workspaceId)).toMatchObject({ template: "bento" })

    await saveDraft(app, workspaceId, [widget], "docs_hub")
    expect((await loadPublishedHome(app, workspaceId)).template).toBe("bento")
    await expect(saveDraft(app, workspaceId, [widget], "magazine")).rejects.toThrow()
  })
})
