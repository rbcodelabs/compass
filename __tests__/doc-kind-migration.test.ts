import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DOC_KIND_MIGRATION, assertDocKindMigration } from "@/lib/migrations/doc-kind"
import { DOC_KIND_BACKFILL_MIGRATION } from "@/lib/migrations/doc-kind-backfill"
import { REVIEWED_MIGRATION_CODE_SHA256 } from "@/lib/preview-automation/managed-manifest"
import { selectMigrationsToRun, skippedExplicitOnly } from "@/lib/migrations/runner"

/**
 * Static guards for 117_doc_kind (additive column) and 118_doc_kind_backfill (explicit-only data migration). The DDL that reaches Aurora DSQL
 * is the SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const executableStatements = (name: string) =>
  read(`prisma/migrations/${name}/migration.sql`).split("\n").map((line) => line.replace(/--.*$/, "")).join("\n").split(";").map((s) => s.trim()).filter(Boolean)
const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])

describe("names", () => {
  it("uses exactly 117_doc_kind and 118_doc_kind_backfill", () => {
    expect(DOC_KIND_MIGRATION).toBe("117_doc_kind")
    expect(DOC_KIND_BACKFILL_MIGRATION).toBe("118_doc_kind_backfill")
  })
})

describe("runner registration", () => {
  it("registers each migration exactly once, 117 after 115 and 118 directly after 117", () => {
    for (const name of ["117_doc_kind", "118_doc_kind_backfill"]) expect([...runner.matchAll(new RegExp(`name:\\s*"${name}"`, "g"))], name).toHaveLength(1)
    expect(names.indexOf("117_doc_kind")).toBeGreaterThan(names.indexOf("115_entity_links_task_link_move"))
    expect(names[names.indexOf("117_doc_kind") + 1]).toBe("118_doc_kind_backfill")
  })

  it("points each entry at its prisma/migrations folder", () => {
    for (const name of ["117_doc_kind", "118_doc_kind_backfill"]) {
      expect(runner).toContain(`path.join(process.cwd(), "prisma/migrations/${name}/migration.sql")`)
    }
  })

  it("keeps 118 explicit-only: an untargeted run never picks it up, a targeted one does", () => {
    const pending = [{ name: "117_doc_kind" }, { name: "118_doc_kind_backfill" }]
    expect(selectMigrationsToRun(pending).map((m) => m.name)).toEqual(["117_doc_kind"])
    expect(skippedExplicitOnly(pending)).toEqual(["118_doc_kind_backfill"])
    expect(selectMigrationsToRun(pending, "118_doc_kind_backfill").map((m) => m.name)).toEqual(["118_doc_kind_backfill"])
    expect(selectMigrationsToRun(pending, "117_doc_kind").map((m) => m.name)).toEqual(["117_doc_kind"])
  })

  it("leaves 117 as an ordinary migration (not explicit-only)", () => {
    expect(skippedExplicitOnly([{ name: "117_doc_kind" }])).toEqual([])
  })

  it("runs the 117 postcondition and the 118 backfill + postcondition before the completion receipt", () => {
    const receipt = runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP')
    const assert117 = runner.indexOf('migration.name === "117_doc_kind") await assertDocKindMigration')
    expect(assert117).toBeGreaterThan(-1)
    expect(assert117).toBeLessThan(receipt)
    const block = runner.indexOf("migration.name === DOC_KIND_BACKFILL_MIGRATION")
    expect(block).toBeGreaterThan(-1)
    const backfill = runner.indexOf("await backfillDocKinds(", block)
    const assert118 = runner.indexOf("await assertDocKindBackfill(", block)
    expect(backfill).toBeGreaterThan(block)
    expect(assert118).toBeGreaterThan(backfill)
    expect(assert118).toBeLessThan(receipt)
  })
})

describe("117 SQL and schema.prisma", () => {
  it("adds exactly one nullable VARCHAR(30) column: no default, NOT NULL, index, FK, check, backfill or drop (DSQL)", () => {
    expect(executableStatements("117_doc_kind")).toEqual(["ALTER TABLE docs ADD COLUMN IF NOT EXISTS kind VARCHAR(30)"])
    const sql = executableStatements("117_doc_kind").join(";\n")
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP|WHERE|CREATE TYPE|ENUM/i)
  })

  it("maps Doc.kind to docs.kind as an optional VarChar(30) with no index", () => {
    const model = schema.match(/model Doc \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toMatch(/\bkind\s+String\?\s+@map\("kind"\)\s+@db\.VarChar\(30\)/)
    expect(model).not.toMatch(/@@index\([^)]*kind/)
    expect(model).not.toMatch(/@@unique\([^)]*kind/)
  })
})

describe("118 SQL", () => {
  it("has no executable statement: the work is the hook, and the header says it is explicit-only", () => {
    expect(executableStatements("118_doc_kind_backfill")).toEqual([])
    expect(read("prisma/migrations/118_doc_kind_backfill/migration.sql")).toMatch(/EXPLICIT-ONLY/)
  })
})

describe("managed manifest pins", () => {
  it("pins the 117 and 118 hook code, and the shared classifier, for review", () => {
    expect(Object.keys(REVIEWED_MIGRATION_CODE_SHA256["117_doc_kind"] ?? {})).toContain("lib/migrations/doc-kind.ts")
    const pins118 = Object.keys(REVIEWED_MIGRATION_CODE_SHA256["118_doc_kind_backfill"] ?? {})
    expect(pins118).toEqual(expect.arrayContaining(["lib/migrations/doc-kind-backfill.ts", "lib/doc-kind-backfill.ts", "lib/doc-kinds.ts"]))
  })
})

type Row = { column_name: string; data_type: string; is_nullable: string }
const clientFor = (rows: Row[]) => ({ query: async () => ({ rows }) }) as never

describe("assertDocKindMigration", () => {
  const good: Row = { column_name: "kind", data_type: "character varying", is_nullable: "YES" }
  it("accepts a nullable varchar kind column", async () => {
    await expect(assertDocKindMigration(clientFor([good]), "s")).resolves.toBeUndefined()
  })

  it("fails closed on a missing, mistyped or NOT NULL column", async () => {
    await expect(assertDocKindMigration(clientFor([]), "s")).rejects.toThrow(/docs\.kind missing/)
    await expect(assertDocKindMigration(clientFor([{ ...good, data_type: "text" }]), "s")).rejects.toThrow(/type postcondition/)
    await expect(assertDocKindMigration(clientFor([{ ...good, is_nullable: "NO" }]), "s")).rejects.toThrow(/NOT NULL/)
  })
})
