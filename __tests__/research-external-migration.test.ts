import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = process.cwd()
const NAME = "076_research_external_studies"

function sql(): string {
  return readFileSync(path.join(ROOT, "prisma/migrations", NAME, "migration.sql"), "utf-8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
}
const statements = () => sql().split(";").map((statement) => statement.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, after 074", () => {
    const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
    const names = [...runner.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1])
    expect(names.filter((name) => name === NAME)).toHaveLength(1)
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf("074_portal_home_layout"))
  })

  it("is five plain nullable ADD COLUMNs: no default, backfill, index, CHECK, NOT NULL or foreign key", () => {
    expect(statements()).toEqual([
      "ALTER TABLE research_studies ADD COLUMN IF NOT EXISTS external_provider VARCHAR(30)",
      "ALTER TABLE research_studies ADD COLUMN IF NOT EXISTS external_url TEXT",
      "ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS provenance VARCHAR(30)",
      "ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS external_url TEXT",
      "ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS session_notes TEXT",
    ])
    expect(statements().join("\n")).not.toMatch(/NOT NULL|DEFAULT|REFERENCES|FOREIGN KEY|CHECK|INDEX|UPDATE|INSERT|DROP/i)
  })

  it("declares every added column in schema.prisma with the exact mapping", () => {
    const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
    const study = schema.match(/model ResearchStudy \{[\s\S]*?\n\}/)?.[0] ?? ""
    const session = schema.match(/model ResearchSession \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(study).toMatch(/externalProvider\s+String\?\s+@map\("external_provider"\)\s+@db\.VarChar\(30\)/)
    expect(study).toMatch(/externalUrl\s+String\?\s+@map\("external_url"\)\s+@db\.Text/)
    expect(session).toMatch(/provenance\s+String\?\s+@db\.VarChar\(30\)/)
    expect(session).toMatch(/externalUrl\s+String\?\s+@map\("external_url"\)\s+@db\.Text/)
    expect(session).toMatch(/sessionNotes\s+String\?\s+@map\("session_notes"\)\s+@db\.Text/)
  })
})
