import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import type { AppPrismaClient } from "@/lib/db"
import { applyMigrations } from "@/lib/migrations/runner"
import { getDocPublishState, getPublishedDoc, listPublishedDocs, publishableDocWhere, setDocPublished } from "@/lib/portal-docs/service"
import { createWidget } from "@/lib/portal-home/schema"
import { loadHomeLayout, loadPublishedHome, publishDraft, saveDraft } from "@/lib/portal-home/service"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

// Runs 113 and 114 through the registered runner against a throwaway schema in the local compass_e2e database.
// Skipped unless INTEGRATION_TEST_DATABASE_URL is set (same convention as the 074/075 tests).
const databaseUrl = integrationDatabaseUrl
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

// Regression: docs.doc_type is NULLABLE with no default in the real database (migration 025 added it as bare
// VARCHAR(50) and backfilled only the rows that existed then), even though Prisma types it as a non-null String.
// Rows inserted by raw SQL that omits doc_type (seed-screenshots.ts, which seeds the preview sample workspace's
// "PRD: AI-Powered Opportunity Clustering") therefore carry NULL. `doc_type <> 'CANVAS'` is NULL (not true) for
// them, so a predicate of `docType: { not: "CANVAS" }` silently hid a doc that getDocPublishState/setDocPublished
// happily accepted: publish returned 200 and the customer URL 404'd.
describe.skipIf(!databaseUrl)("publishing a doc whose doc_type is NULL (raw-SQL seeded rows)", () => {
  const schema = `dnull_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  let prisma: PrismaClient
  const workspaceId = randomUUID()
  const userId = randomUUID()
  const insertDoc = async (title: string, columns: { doc_type?: string | null; storage_provider?: string | null } = {}) => {
    const id = randomUUID()
    await pool.query(
      `INSERT INTO "${schema}".docs (id, workspace_id, title, content, doc_type, storage_provider) VALUES ($1,$2,$3,'## Problem\n\nBody',$4,$5)`,
      [id, workspaceId, title, columns.doc_type ?? null, columns.storage_provider ?? null],
    )
    return id
  }
  beforeAll(async () => {
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await pool.query(`CREATE TABLE "${schema}".workspaces (id UUID PRIMARY KEY, organization_id UUID NOT NULL DEFAULT gen_random_uuid(), slug VARCHAR(255) NOT NULL DEFAULT 's', name VARCHAR(255) NOT NULL DEFAULT 'n')`)
    await pool.query(`CREATE TABLE "${schema}".workspace_members (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, user_id UUID NOT NULL, role VARCHAR(50) NOT NULL DEFAULT 'MEMBER', created_at TIMESTAMP(3) NOT NULL DEFAULT now())`)
    // doc_type deliberately nullable with NO default, exactly as migration 025 leaves it.
    await pool.query(`CREATE TABLE "${schema}".docs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, title VARCHAR(255) NOT NULL, content TEXT, parent_id UUID, storage_provider VARCHAR(20), doc_type VARCHAR(50), updated_at TIMESTAMP(3) NOT NULL DEFAULT now(), published_at TIMESTAMP(3), published_by_id UUID)`)
    await pool.query(`INSERT INTO "${schema}".workspaces (id) VALUES ($1)`, [workspaceId])
    await pool.query(`INSERT INTO "${schema}".workspace_members (workspace_id, user_id) VALUES ($1,$2)`, [workspaceId, userId])
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

  it("is publicly readable and listed after publish, exactly as getDocPublishState promised", async () => {
    const app = prisma as unknown as AppPrismaClient
    const docId = await insertDoc("PRD: AI-Powered Opportunity Clustering", { doc_type: null })
    const standardId = await insertDoc("created through the app", { doc_type: "STANDARD" })

    expect((await pool.query(`SELECT doc_type FROM "${schema}".docs WHERE id=$1`, [docId])).rows[0].doc_type).toBeNull()
    expect(await getDocPublishState(app, workspaceId, docId)).toMatchObject({ publishable: true })

    for (const id of [docId, standardId]) expect((await setDocPublished(app, { userId, docId: id, published: true })).published).toBe(true)

    expect((await getPublishedDoc(app, workspaceId, docId))?.id).toBe(docId)
    expect((await getPublishedDoc(app, workspaceId, standardId))?.id).toBe(standardId)
    const listed = (await listPublishedDocs(app, workspaceId)).map((d) => d.id)
    expect(listed).toEqual(expect.arrayContaining([docId, standardId]))
    expect((await listPublishedDocs(app, workspaceId, { ids: [docId] })).map((d) => d.id)).toEqual([docId])
  })

  it("keeps canvas and externally-stored docs out, and getDocPublishState agrees with the public read for every combination", async () => {
    const app = prisma as unknown as AppPrismaClient
    const cases: [string, { doc_type: string | null; storage_provider: string | null }, boolean][] = [
      ["null/null", { doc_type: null, storage_provider: null }, true],
      ["null/DB", { doc_type: null, storage_provider: "DB" }, true],
      ["standard", { doc_type: "STANDARD", storage_provider: null }, true],
      ["gtm brief", { doc_type: "GTM_POSITIONING_BRIEF", storage_provider: null }, true],
      ["canvas", { doc_type: "CANVAS", storage_provider: null }, false],
      ["geode", { doc_type: "STANDARD", storage_provider: "GEODE" }, false],
      ["null/geode", { doc_type: null, storage_provider: "GEODE" }, false],
    ]
    for (const [label, columns, expected] of cases) {
      const id = await insertDoc(label, columns)
      expect((await getDocPublishState(app, workspaceId, id)).publishable, `${label}: publish state`).toBe(expected)
      // Force published_at directly so the public read is judged independent of setDocPublished's own gate.
      await pool.query(`UPDATE "${schema}".docs SET published_at = now() WHERE id=$1`, [id])
      expect((await getPublishedDoc(app, workspaceId, id)) !== null, `${label}: public read`).toBe(expected)
      expect((await listPublishedDocs(app, workspaceId, { ids: [id] })).length === 1, `${label}: public list`).toBe(expected)
      // The admin picker predicate must agree too.
      expect(!!(await app.doc.findFirst({ where: { ...publishableDocWhere(workspaceId), id }, select: { id: true } })), `${label}: picker`).toBe(expected)
    }
  })
})
