import { describe, expect, it, vi } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { PoolClient } from "pg"
import {
  SAVED_VIEWS_SURFACE_BACKFILL_BATCH_SIZE, assertSavedViewsSurfaceMigration, backfillSavedViewsSurface,
} from "@/lib/migrations/saved-views-surface"

/**
 * Guards for 100_saved_views_surface. The DDL that reaches Aurora DSQL is the SQL file, not schema.prisma,
 * so the two are pinned to each other here, plus the backfill hook and its postcondition.
 */
const ROOT = process.cwd()
const NAME = "100_saved_views_surface"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after the 098/099 migrations", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "098_entity_links_backfill_solution_key_result"'))
  })

  it("is one bare nullable ADD COLUMN then one async non-unique index", () => {
    expect(statements).toHaveLength(2)
    expect(statements[0]).toMatch(/^ALTER TABLE roadmap_views ADD COLUMN IF NOT EXISTS surface VARCHAR\(40\)$/i)
    expect(statements[1]).toMatch(/^CREATE INDEX ASYNC IF NOT EXISTS idx_roadmap_views_org_surface_kind ON roadmap_views\(organization_id, workspace_id, surface\)$/i)
  })

  it("has no default, constraint, foreign key, trigger, rename or data write in the SQL (the backfill is a hook)", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TRIGGER|\bDEFAULT\b|NOT NULL|UNIQUE|\bWHERE\b|\bUPDATE\b|\bINSERT\b|\bDELETE\b|RENAME|DROP/i)
  })

  it("maps the same column, index and table in schema.prisma", () => {
    const model = schema.match(/model SavedView \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toMatch(/surface\s+String\?\s+@db\.VarChar\(40\)/)
    expect(model).toContain('map: "idx_roadmap_views_org_surface_kind"')
    expect(model).toContain('@@map("roadmap_views")')
    expect(schema).not.toContain("model RoadmapView ")
  })

  it("waits for its async index and runs backfill + postcondition before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"100_saved_views_surface"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"100_saved_views_surface"[^\]]*\]\.includes\(migration\.name\)/)
    const hook = runner.indexOf("migration.name === SAVED_VIEWS_SURFACE_MIGRATION")
    expect(hook).toBeGreaterThan(-1)
    expect(runner.indexOf("await backfillSavedViewsSurface", hook)).toBeGreaterThan(hook)
    expect(runner.indexOf("await assertSavedViewsSurfaceMigration", hook)).toBeGreaterThan(runner.indexOf("await backfillSavedViewsSurface", hook))
    expect(hook).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})

type Query = { text: string; values: unknown[] }

/** A fake client holding `nullRows` legacy rows; each UPDATE stamps up to the ids it is given. */
function backfillClient(nullRows: number) {
  let remaining = nullRows
  const queries: Query[] = []
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values })
      if (/^\s*SELECT id/i.test(text)) {
        const n = Math.min(remaining, values[0] as number)
        return { rows: Array.from({ length: n }, (_, i) => ({ id: `id-${i}` })), rowCount: n }
      }
      if (/^\s*UPDATE/i.test(text)) {
        const n = (values[0] as string[]).length
        remaining -= n
        return { rows: [], rowCount: n }
      }
      throw new Error(`unexpected query ${text}`)
    }),
  } as unknown as PoolClient
  return { client, queries, remaining: () => remaining }
}

describe("backfillSavedViewsSurface", () => {
  it("stamps legacy rows in bounded batches, only where surface IS NULL", async () => {
    const { client, queries, remaining } = backfillClient(SAVED_VIEWS_SURFACE_BACKFILL_BATCH_SIZE + 5)
    const log: string[] = []
    expect(await backfillSavedViewsSurface(client, "s", log)).toBe(SAVED_VIEWS_SURFACE_BACKFILL_BATCH_SIZE + 5)
    expect(remaining()).toBe(0)
    const updates = queries.filter((q) => /^\s*UPDATE/i.test(q.text))
    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(update.text).toMatch(/surface IS NULL/)
      expect(update.text).toMatch(/workspace_id IS NULL THEN 'ROADMAP_ORG' ELSE 'ROADMAP_WORKSPACE'/)
    }
    expect(log[0]).toContain("backfilled")
  })

  it("is a no-op when nothing is left (idempotent rerun)", async () => {
    const { client, queries } = backfillClient(0)
    expect(await backfillSavedViewsSurface(client, "s")).toBe(0)
    expect(queries.some((q) => /^\s*UPDATE/i.test(q.text))).toBe(false)
  })
})

describe("assertSavedViewsSurfaceMigration", () => {
  const goodIndex = { valid: true, ready: true, unique: false, table_name: "roadmap_views", columns: ["organization_id", "workspace_id", "surface"], predicate: null, expression: null }
  function client(over: { column?: unknown[]; index?: unknown[]; nulls?: string } = {}) {
    return {
      query: vi.fn(async (text: string) => {
        if (/information_schema\.columns/.test(text)) return { rows: over.column ?? [{ is_nullable: "YES", data_type: "character varying" }] }
        if (/pg_index/.test(text)) return { rows: over.index ?? [goodIndex] }
        return { rows: [{ remaining: over.nulls ?? "0" }] }
      }),
    } as unknown as PoolClient
  }

  it("passes for a nullable varchar column, a ready index and no NULL surfaces", async () => {
    await expect(assertSavedViewsSurfaceMigration(client(), "s")).resolves.toBeUndefined()
  })

  it("fails closed on a missing or NOT NULL column, a drifted or unfinished index, or leftover NULLs", async () => {
    await expect(assertSavedViewsSurfaceMigration(client({ column: [] }), "s")).rejects.toThrow(/surface must be a nullable varchar/)
    await expect(assertSavedViewsSurfaceMigration(client({ column: [{ is_nullable: "NO", data_type: "character varying" }] }), "s")).rejects.toThrow(/nullable/)
    await expect(assertSavedViewsSurfaceMigration(client({ index: [] }), "s")).rejects.toThrow(/not ready or has drifted/)
    await expect(assertSavedViewsSurfaceMigration(client({ index: [{ ...goodIndex, ready: false }] }), "s")).rejects.toThrow(/not ready/)
    await expect(assertSavedViewsSurfaceMigration(client({ index: [{ ...goodIndex, columns: ["organization_id", "workspace_id"] }] }), "s")).rejects.toThrow(/drifted/)
    await expect(assertSavedViewsSurfaceMigration(client({ nulls: "3" }), "s")).rejects.toThrow(/3 roadmap_views rows still have a NULL surface/)
  })
})
