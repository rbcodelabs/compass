import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
import { feedbackAttachmentTable, findReferencedFeedbackKeys } from "@/lib/feedback-attachment-ownership"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * The one real-PostgreSQL check of the release guard's reference scan: the single bound-parameter ILIKE on the workspace UUID,
 * its schema qualifier (resolved through the real getActiveSchema()), and the app-side canonicalization of what it returns.
 * Design: Products/Compass/Runs/compass-attachment-leak-small-fix-design.md, guard 2.
 *
 * Set INTEGRATION_TEST_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = integrationDatabaseUrl

describe.skipIf(!databaseUrl)("feedback attachment reference scan on real PostgreSQL", () => {
  // getActiveSchema() = `${PGSCHEMA}_dev` outside production, so the helper's default qualifier lands on this schema.
  const prefix = `fa_scan_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const schema = `${prefix}_dev`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  const appPool = new Pool({ connectionString: databaseUrl, max: 4 })
  let prisma: AppPrismaClient
  let owned = false

  const WS = randomUUID()
  const OTHER = randomUUID()
  const HOST = "store123.public.blob.vercel-storage.com"
  const url = (ws: string, name: string, suffix = "") => `https://${HOST}/feedback/${ws}/${name}${suffix}`
  const key = (name: string) => `feedback/${WS}/${name}`

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/compass_e2e" || parsed.searchParams.has("schema")) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    vi.stubEnv("PGSCHEMA", prefix)
    vi.stubEnv("COMPASS_ENV", "development")
    vi.stubEnv("VERCEL_ENV", "")
    await admin.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    // Only the columns the scan reads; the table name and `url` TEXT column are what prisma/schema.prisma maps.
    await admin.query(`CREATE TABLE "${schema}".feedback_attachment (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feedback_item_id uuid NOT NULL, url text NOT NULL)`)
    const rows: string[] = [
      url(OTHER, "unrelated.png"), // another workspace's own file: must not match
      url(WS, "plain.png"),
      url(WS, "query.png", "?download=1"),
      url(WS, "fragment.png", "#top"),
      url(WS.toUpperCase(), "UPPER.PNG"),
      url(WS, "enc%2Epng"), // percent-encoded dot in the filename, UUID literal
      url(WS, "bad.png", "%E0%A4%A"), // cannot be decoded
      url(WS, "50%25.png"), // literal %, decodes once to "50%.png" (a different, unparseable-as-key name)
    ]
    for (const u of rows) await admin.query(`INSERT INTO "${schema}".feedback_attachment (feedback_item_id, url) VALUES ($1, $2)`, [randomUUID(), u])
    prisma = new PrismaClient({ adapter: new PrismaPg(appPool, { schema }) }) as unknown as AppPrismaClient
  }, 60_000)

  afterAll(async () => {
    await (prisma as unknown as PrismaClient | undefined)?.$disconnect()
    if (owned) await admin.query(`DROP SCHEMA "${schema}" CASCADE`)
    await admin.end()
    vi.unstubAllEnvs()
  })

  it("qualifies the schema from getActiveSchema() and runs as one bound-parameter ILIKE", async () => {
    expect(feedbackAttachmentTable().text).toBe(`"${schema}"."feedback_attachment"`)
    const rows = await prisma.$queryRaw<{ url: string }[]>`SELECT url FROM ${feedbackAttachmentTable()} WHERE url ILIKE '%' || ${WS}::text || '%'`
    expect(rows.length).toBe(7) // every WS-mentioning row, case-insensitively, and not the other workspace's
  })

  it("canonicalizes each matching row and reports exactly the referenced keys", async () => {
    const candidates = ["plain.png", "query.png", "fragment.png", "upper.png", "enc.png", "free.png"].map(key)
    const referenced = await findReferencedFeedbackKeys(prisma, WS, candidates)
    // plain/query/fragment/uppercase/once-decoded rows reference their keys. The undecodable row cannot be attributed to a key, so it
    // counts as a reference to every candidate (fail closed): nothing here is deletable.
    expect([...referenced].sort()).toEqual([...candidates].sort())
  })

  it("with no unparseable row in play, only the keys that rows actually reference are reported", async () => {
    await admin.query(`DELETE FROM "${schema}".feedback_attachment WHERE url = $1`, [url(WS, "bad.png", "%E0%A4%A")])
    const candidates = ["plain.png", "query.png", "fragment.png", "upper.png", "enc.png", "free.png"].map(key)
    const referenced = await findReferencedFeedbackKeys(prisma, WS, candidates)
    expect([...referenced].sort()).toEqual(["plain.png", "query.png", "fragment.png", "upper.png", "enc.png"].map(key).sort())
  })

  it("is empty when no row mentions the workspace", async () => {
    expect([...(await findReferencedFeedbackKeys(prisma, randomUUID(), [key("plain.png")]))]).toEqual([])
  })
})
