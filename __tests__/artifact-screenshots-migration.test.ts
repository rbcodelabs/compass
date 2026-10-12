import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { assertArtifactScreenshotsMigration } from "@/lib/migrations/artifact-screenshots"

/**
 * Static guards for 077_artifact_screenshots. The DDL that reaches Aurora DSQL
 * is the SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "077_artifact_screenshots"
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const sql = read(`prisma/migrations/${NAME}/migration.sql`).split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
  })

  it("is seven idempotent nullable ADD COLUMNs: no default, backfill, index, CHECK, NOT NULL or foreign key", () => {
    expect(statements).toEqual([
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_pathname TEXT",
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_mime_type VARCHAR(100)",
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_byte_size INTEGER",
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_width INTEGER",
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_height INTEGER",
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_captured_at TIMESTAMP",
      "ALTER TABLE artifact_revisions ADD COLUMN IF NOT EXISTS thumbnail_source_url TEXT",
    ])
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP/i)
  })

  it("declares every column on ArtifactRevision in schema.prisma as nullable", () => {
    const model = schema.match(/model ArtifactRevision \{[\s\S]*?\n\}/)?.[0] ?? ""
    for (const column of ["thumbnail_pathname", "thumbnail_mime_type", "thumbnail_byte_size", "thumbnail_width", "thumbnail_height", "thumbnail_captured_at", "thumbnail_source_url"]) {
      expect(model).toMatch(new RegExp(`\\?\\s+@map\\("${column}"\\)`))
    }
  })

  it("runs its postcondition before the completion receipt", () => {
    const assertion = runner.indexOf(`migration.name === "${NAME}") await assertArtifactScreenshotsMigration`)
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})

describe("assertArtifactScreenshotsMigration", () => {
  const good = [
    { column_name: "thumbnail_pathname", data_type: "text", character_maximum_length: null },
    { column_name: "thumbnail_mime_type", data_type: "character varying", character_maximum_length: 100 },
    { column_name: "thumbnail_byte_size", data_type: "integer", character_maximum_length: null },
    { column_name: "thumbnail_width", data_type: "integer", character_maximum_length: null },
    { column_name: "thumbnail_height", data_type: "integer", character_maximum_length: null },
    { column_name: "thumbnail_captured_at", data_type: "timestamp without time zone", character_maximum_length: null },
    { column_name: "thumbnail_source_url", data_type: "text", character_maximum_length: null },
  ].map((row) => ({ ...row, is_nullable: "YES", column_default: null }))
  const clientFor = (rows: unknown[]) => ({ query: async () => ({ rows }) }) as never

  it("accepts the expected columns", async () => {
    await expect(assertArtifactScreenshotsMigration(clientFor(good), "compass_test")).resolves.toBeUndefined()
  })

  it("fails closed on a missing, mistyped or NOT NULL column", async () => {
    await expect(assertArtifactScreenshotsMigration(clientFor(good.slice(1)), "s")).rejects.toThrow(/thumbnail_pathname/)
    await expect(assertArtifactScreenshotsMigration(clientFor([{ ...good[0], data_type: "integer" }, ...good.slice(1)]), "s")).rejects.toThrow(/invalid columns/)
    await expect(assertArtifactScreenshotsMigration(clientFor([{ ...good[0], is_nullable: "NO" }, ...good.slice(1)]), "s")).rejects.toThrow(/thumbnail_pathname/)
  })

  it("reports a missing table distinctly", async () => {
    await expect(assertArtifactScreenshotsMigration(clientFor([]), "s")).rejects.toThrow(/does not exist/)
  })
})
