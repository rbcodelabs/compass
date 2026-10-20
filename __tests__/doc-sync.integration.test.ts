/**
 * Real Prisma client + PrismaPg adapter + real Postgres (READ COMMITTED), throwaway schema of the local
 * compass_e2e database. Proves what the in-memory fake cannot for the doc change log:
 *   1. concurrent writers in ONE workspace all commit, with distinct, gap-free seqs (the counter row lock
 *      serializes them and the counter is locked BEFORE the doc tree is read);
 *   2. two writers that each create a same-titled sibling see each other's committed tree, so the
 *      collision-suffix rename of the first doc is logged exactly once;
 *   3. the real 092 SQL (minus ASYNC, as the runner does for DATABASE_URL) matches the Prisma models.
 * Skipped unless a database is configured (it is not part of the tq unit gate):
 *
 *   DOC_SYNC_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5437/compass_e2e \
 *     npx vitest run __tests__/doc-sync.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"

const holder = vi.hoisted(() => ({ client: null as unknown }))
vi.mock("@/lib/db", () => ({ default: () => holder.client }))

import { recordDocChange, withDocChangeRetry } from "@/lib/doc-sync"

const databaseUrl = process.env.DOC_SYNC_TEST_DATABASE_URL

describe.skipIf(!databaseUrl)("doc change log against real Postgres", () => {
  const schema = `docsync_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 12 })
  const previous = { url: process.env.DATABASE_URL, flag: process.env.DOCS_SYNC_ENABLED }
  const WS = randomUUID()
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("{S}", `"${schema}"`), params)
  let prisma: AppPrismaClient

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e") throw new Error("Requires the local compass_e2e database")
    process.env.DATABASE_URL = databaseUrl
    process.env.DOCS_SYNC_ENABLED = "1"
    await pool.query(`CREATE SCHEMA "${schema}"`)
    await q(`CREATE TABLE {S}.docs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id UUID NOT NULL, parent_id UUID, title VARCHAR(255) NOT NULL,
      content TEXT, storage_provider VARCHAR(20), content_ref TEXT, revision UUID, metadata JSON, icon VARCHAR(50),
      sort_order INTEGER NOT NULL DEFAULT 0, roadmap_item_id UUID UNIQUE, doc_type VARCHAR(50) NOT NULL DEFAULT 'STANDARD',
      created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_by_id UUID, updated_by_id UUID, source VARCHAR(20) NOT NULL DEFAULT 'UI')`)
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/092_doc_changes/migration.sql"), "utf-8")
    for (const statement of sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean)) {
      await q(statement.replace(/\bINDEX ASYNC\b/gi, "INDEX"))
    }
    const { PrismaClient } = await import("@prisma/client")
    const { PrismaPg } = await import("@prisma/adapter-pg")
    const { injectUpdatedAtExtension } = await import("@/lib/prisma-updated-at")
    holder.client = prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema }) }).$extends(injectUpdatedAtExtension) as unknown as AppPrismaClient
  })

  afterAll(async () => {
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`) } finally {
      await pool.end()
      if (previous.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous.url
      if (previous.flag === undefined) delete process.env.DOCS_SYNC_ENABLED; else process.env.DOCS_SYNC_ENABLED = previous.flag
    }
  })

  const createLogged = (title: string) =>
    withDocChangeRetry(() => prisma.$transaction(async (tx) => {
      const doc = await tx.doc.create({ data: { workspaceId: WS, title, content: "x", revision: randomUUID() } })
      await recordDocChange(tx, WS, doc.id, "UPSERT", null)
      return doc
    }))

  it("concurrent writers in one workspace all commit with distinct, gap-free seqs", async () => {
    const docs = await Promise.all(Array.from({ length: 10 }, (_, i) => createLogged(`Doc ${i}`)))
    expect(docs).toHaveLength(10)
    const seqs = (await q(`SELECT seq FROM {S}.doc_changes WHERE workspace_id = $1 ORDER BY seq`, [WS])).rows.map((r) => r.seq)
    expect(seqs).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
    expect((await q(`SELECT last_seq FROM {S}.doc_change_counters WHERE workspace_id = $1`, [WS])).rows[0].last_seq).toBe(10)
  })

  it("two same-titled siblings created concurrently log the suffix rename exactly once", async () => {
    await Promise.all([createLogged("Twin"), createLogged("Twin")])
    // Whichever transaction locked second read the first's committed row, so the LATEST logged path per
    // doc is the final one: exactly one bare "Twin" and one suffixed twin, never two bare titles.
    const latest = (await q(`SELECT DISTINCT ON (doc_id) doc_id, path FROM {S}.doc_changes WHERE workspace_id = $1 AND path LIKE 'Twin%' ORDER BY doc_id, seq DESC`, [WS])).rows.map((r) => r.path)
    expect(latest).toHaveLength(2)
    expect(latest.filter((p) => p === "Twin")).toHaveLength(1)
    expect(latest.filter((p) => /^Twin \([0-9a-f]{8}\)$/.test(p))).toHaveLength(1)
  })
})
