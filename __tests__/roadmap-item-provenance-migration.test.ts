import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { assertRoadmapItemProvenanceMigration } from "@/lib/migrations/roadmap-item-provenance"

/**
 * Static guards for 075_roadmap_item_provenance. The DDL that reaches Aurora DSQL
 * is the SQL file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "075_roadmap_item_provenance"
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf-8")
const runner = read("lib/migrations/runner.ts")
const schema = read("prisma/schema.prisma")
const sql = read(`prisma/migrations/${NAME}/migration.sql`).split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 074, as the last migration", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    const names = [...runner.matchAll(/name:\s*"(\d{3}_[a-z0-9_]+)"/g)].map((match) => match[1])
    expect(names[names.length - 1]).toBe(NAME)
    expect(names[names.indexOf(NAME) - 1]).toBe("074_portal_home_layout")
  })

  it("is two plain nullable ADD COLUMNs: no default, backfill, index, CHECK, NOT NULL or foreign key", () => {
    expect(statements).toEqual([
      "ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS auto_created BOOLEAN",
      "ALTER TABLE roadmap_items ADD COLUMN IF NOT EXISTS schedule_edited_at TIMESTAMP(3)",
    ])
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP/i)
  })

  it("declares both columns on RoadmapItem in schema.prisma, nullable and with no @updatedAt", () => {
    const model = schema.match(/model RoadmapItem \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(model).toMatch(/autoCreated\s+Boolean\?\s+@map\("auto_created"\)/)
    expect(model).toMatch(/scheduleEditedAt\s+DateTime\?\s+@map\("schedule_edited_at"\)/)
    expect(model).not.toMatch(/@updatedAt/)
  })

  it("runs its postcondition before the completion receipt", () => {
    const assertion = runner.indexOf(`migration.name === "${NAME}") await assertRoadmapItemProvenanceMigration`)
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})

describe("assertRoadmapItemProvenanceMigration", () => {
  const clientFor = (rows: Array<{ column_name: string; data_type: string; is_nullable: string }>) =>
    ({ query: async () => ({ rows }) }) as never
  const good = [
    { column_name: "auto_created", data_type: "boolean", is_nullable: "YES" },
    { column_name: "schedule_edited_at", data_type: "timestamp without time zone", is_nullable: "YES" },
  ]

  it("accepts the expected columns", async () => {
    await expect(assertRoadmapItemProvenanceMigration(clientFor(good), "compass_test")).resolves.toBeUndefined()
  })

  it("fails closed on a missing, mistyped or NOT NULL column", async () => {
    await expect(assertRoadmapItemProvenanceMigration(clientFor(good.slice(0, 1)), "s")).rejects.toThrow(/schedule_edited_at missing/)
    await expect(assertRoadmapItemProvenanceMigration(clientFor([{ ...good[0], data_type: "text" }, good[1]]), "s")).rejects.toThrow(/type postcondition/)
    await expect(assertRoadmapItemProvenanceMigration(clientFor([good[0], { ...good[1], is_nullable: "NO" }]), "s")).rejects.toThrow(/NOT NULL/)
  })
})
