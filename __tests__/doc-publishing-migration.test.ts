import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { assertDocPublishingMigration } from "@/lib/migrations/doc-publishing"
import { assertPortalHomeTemplateMigration } from "@/lib/migrations/portal-home-template"

/**
 * Static guards for 113_doc_publishing and 114_portal_home_template. The DDL that reaches Aurora DSQL is the
 * SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const statementsOf = (name: string) =>
  read(`prisma/migrations/${name}/migration.sql`).split("\n").map((line) => line.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe.each([
  ["113_doc_publishing", "112_agent_conversation_archive", "assertDocPublishingMigration"],
  ["114_portal_home_template", "113_doc_publishing", "assertPortalHomeTemplateMigration"],
])("%s", (name, previous, assertion) => {
  it("is registered exactly once, directly after the previous migration", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${name}"`, "g"))]).toHaveLength(1)
    expect(names[names.indexOf(name) - 1]).toBe(previous)
  })

  it("is bare nullable idempotent ADD COLUMNs: no default, NOT NULL, index, FK, backfill or drop (DSQL)", () => {
    const sql = statementsOf(name).join(";\n")
    for (const statement of statementsOf(name)) expect(statement).toMatch(/^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+ [A-Z0-9()]+$/)
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP|WHERE/i)
  })

  it("runs its postcondition before the completion receipt", () => {
    const call = runner.indexOf(`migration.name === "${name}") await ${assertion}`)
    expect(call).toBeGreaterThan(-1)
    expect(call).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})

describe("migration SQL matches schema.prisma", () => {
  it("113 adds exactly docs.published_at and docs.published_by_id", () => {
    expect(statementsOf("113_doc_publishing")).toEqual([
      "ALTER TABLE docs ADD COLUMN IF NOT EXISTS published_at TIMESTAMP(3)",
      "ALTER TABLE docs ADD COLUMN IF NOT EXISTS published_by_id UUID",
    ])
    const model = schema.match(/model Doc \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toMatch(/publishedAt\s+DateTime\?\s+@map\("published_at"\)/)
    expect(model).toMatch(/publishedById\s+String\?\s+@map\("published_by_id"\)\s+@db\.Uuid/)
  })

  it("114 adds exactly the two nullable template columns", () => {
    expect(statementsOf("114_portal_home_template")).toEqual([
      "ALTER TABLE portal_home_layouts ADD COLUMN IF NOT EXISTS draft_template VARCHAR(20)",
      "ALTER TABLE portal_home_layouts ADD COLUMN IF NOT EXISTS published_template VARCHAR(20)",
    ])
    const model = schema.match(/model PortalHomeLayout \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toMatch(/draftTemplate\s+String\?\s+@map\("draft_template"\)\s+@db\.VarChar\(20\)/)
    expect(model).toMatch(/publishedTemplate\s+String\?\s+@map\("published_template"\)\s+@db\.VarChar\(20\)/)
  })
})

type Row = { column_name: string; data_type: string; is_nullable: string }
const clientFor = (rows: Row[]) => ({ query: async () => ({ rows }) }) as never

describe("assertDocPublishingMigration", () => {
  const good: Row[] = [
    { column_name: "published_at", data_type: "timestamp without time zone", is_nullable: "YES" },
    { column_name: "published_by_id", data_type: "uuid", is_nullable: "YES" },
  ]
  it("accepts the expected columns", async () => {
    await expect(assertDocPublishingMigration(clientFor(good), "s")).resolves.toBeUndefined()
  })
  it("fails closed on a missing, mistyped or NOT NULL column", async () => {
    await expect(assertDocPublishingMigration(clientFor(good.slice(0, 1)), "s")).rejects.toThrow(/published_by_id missing/)
    await expect(assertDocPublishingMigration(clientFor([{ ...good[0], data_type: "text" }, good[1]]), "s")).rejects.toThrow(/type postcondition/)
    await expect(assertDocPublishingMigration(clientFor([good[0], { ...good[1], is_nullable: "NO" }]), "s")).rejects.toThrow(/NOT NULL/)
  })
})

describe("assertPortalHomeTemplateMigration", () => {
  const good: Row[] = [
    { column_name: "draft_template", data_type: "character varying", is_nullable: "YES" },
    { column_name: "published_template", data_type: "character varying", is_nullable: "YES" },
  ]
  it("accepts the expected columns", async () => {
    await expect(assertPortalHomeTemplateMigration(clientFor(good), "s")).resolves.toBeUndefined()
  })
  it("fails closed on a missing, mistyped or NOT NULL column", async () => {
    await expect(assertPortalHomeTemplateMigration(clientFor([]), "s")).rejects.toThrow(/draft_template missing/)
    await expect(assertPortalHomeTemplateMigration(clientFor([good[0], { ...good[1], data_type: "integer" }]), "s")).rejects.toThrow(/type postcondition/)
    await expect(assertPortalHomeTemplateMigration(clientFor([{ ...good[0], is_nullable: "NO" }, good[1]]), "s")).rejects.toThrow(/NOT NULL/)
  })
})
