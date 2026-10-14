import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import type { AppPrismaClient } from "@/lib/db"
import { createWidget } from "@/lib/portal-home/schema"
import { loadHomeLayout, loadPublishedWidgets, publishDraft, saveDraft } from "@/lib/portal-home/service"

// Runs 074 through the registered runner against a throwaway schema in the local
// compass_e2e database, then exercises the real Prisma model and the draft /
// publish service against the resulting table. Skipped unless
// UPDATES_TEST_DATABASE_URL is set (same convention as the 068 follows test).
const databaseUrl = process.env.UPDATES_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)("portal home layout registered migration", () => {
  const schema = `phl_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  let created = false
  let prisma: PrismaClient
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires local compass_e2e")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    created = true
  })
  afterAll(async () => {
    try {
      await prisma?.$disconnect()
      if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    } finally {
      await pool.end()
      if (previous === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previous
    }
  })

  it("creates the table and its unique index, and reruns with one completed receipt", async () => {
    const first = await applyMigrations(pool, schema, "074_portal_home_layout")
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='portal_home_layouts' ORDER BY column_name", [schema])
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      "created_at", "draft_widgets", "id", "published_at", "published_by_id", "published_widgets", "updated_at", "workspace_id",
    ])
    const index = await pool.query(
      "SELECT i.indisunique,i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='idx_portal_home_layouts_workspace'",
      [schema],
    )
    expect(index.rows).toEqual([{ indisunique: true, indisvalid: true }])
    const again = await applyMigrations(pool, schema, "074_portal_home_layout")
    expect(again.status).toBe(200)
    const receipts = await pool.query(`SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name='074_portal_home_layout' AND finished_at IS NOT NULL`)
    expect(receipts.rows).toHaveLength(1)
  })

  it("saves a draft, keeps it private until published, and enforces one row per workspace", async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
    const app = prisma as unknown as AppPrismaClient
    const workspaceId = randomUUID()

    expect(await loadPublishedWidgets(app, workspaceId)).toBeNull()

    const widget = createWidget("rich_text", 0)
    await saveDraft(app, workspaceId, [widget])
    await saveDraft(app, workspaceId, [widget, createWidget("announcement", 1)])
    const rows = await prisma.portalHomeLayout.findMany({ where: { workspaceId } })
    expect(rows).toHaveLength(1)

    // The draft is invisible to the customer read path.
    expect(await loadPublishedWidgets(app, workspaceId)).toBeNull()
    expect((await loadHomeLayout(app, workspaceId)).draft).toHaveLength(2)

    await expect(prisma.portalHomeLayout.create({ data: { workspaceId, draftWidgets: [] } })).rejects.toMatchObject({ code: "P2002" })

    const { publishedAt } = await publishDraft(app, workspaceId, randomUUID())
    const published = await loadPublishedWidgets(app, workspaceId)
    expect(published?.map((w) => w.type)).toEqual(["rich_text", "announcement"])
    expect(publishedAt).toBeInstanceOf(Date)

    // Editing the draft afterwards does not change what customers see.
    await saveDraft(app, workspaceId, [widget])
    expect((await loadPublishedWidgets(app, workspaceId))?.length).toBe(2)
  })
})
