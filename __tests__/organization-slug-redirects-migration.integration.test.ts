import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"

// Runs 080 through the registered runner against a throwaway schema in the local
// compass_e2e database, then exercises the real Prisma model against the resulting table.
// Skipped unless UPDATES_TEST_DATABASE_URL is set (same convention as the 074 portal home test).
const databaseUrl = process.env.UPDATES_TEST_DATABASE_URL
describe.skipIf(!databaseUrl)("organization slug redirects registered migration", () => {
  const schema = `osr_${randomUUID().replaceAll("-", "")}`
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
    const first = await applyMigrations(pool, schema, "080_organization_slug_redirects")
    const result = await first.json()
    expect(result, JSON.stringify(result)).not.toHaveProperty("error")
    expect(first.status).toBe(200)
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='organization_slug_redirects' ORDER BY column_name",
      [schema],
    )
    expect(columns.rows.map((r) => r.column_name)).toEqual(["created_at", "id", "old_slug", "organization_id"])
    const index = await pool.query(
      "SELECT i.indisunique,i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='idx_organization_slug_redirects_old_slug'",
      [schema],
    )
    expect(index.rows).toEqual([{ indisunique: true, indisvalid: true }])
    const again = await applyMigrations(pool, schema, "080_organization_slug_redirects")
    expect(again.status).toBe(200)
    const receipts = await pool.query(
      `SELECT id FROM "${schema}"._prisma_migrations WHERE migration_name='080_organization_slug_redirects' AND finished_at IS NOT NULL`,
    )
    expect(receipts.rows).toHaveLength(1)
  })

  it("the Prisma model round-trips, and old_slug is globally unique", async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) })
    const orgA = randomUUID()
    const orgB = randomUUID()
    await prisma.organizationSlugRedirect.create({ data: { organizationId: orgA, oldSlug: "acme" } })
    const row = await prisma.organizationSlugRedirect.findUnique({ where: { oldSlug: "acme" } })
    expect(row?.organizationId).toBe(orgA)
    expect(row?.createdAt).toBeInstanceOf(Date)

    // A second organization cannot reserve the same retired slug, even by a racing writer.
    await expect(
      prisma.organizationSlugRedirect.create({ data: { organizationId: orgB, oldSlug: "acme" } }),
    ).rejects.toMatchObject({ code: "P2002" })

    // Rename-back deletes the row, freeing the slug.
    await prisma.organizationSlugRedirect.delete({ where: { oldSlug: "acme" } })
    expect(await prisma.organizationSlugRedirect.findUnique({ where: { oldSlug: "acme" } })).toBeNull()
  })
})
