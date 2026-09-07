import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { voiceMigrationCatalog } from "@/lib/research-voice-migration"

describe("participant voice migration contract", () => {
  it("uses the canonical resumable grammar, separate evidence table and all four validatable indexes", () => {
    const sql = readFileSync(new URL("../prisma/migrations/049_research_participant_voice/migration.sql", import.meta.url), "utf8")
    const catalog = voiceMigrationCatalog(sql)
    expect(catalog.tables).toEqual(["research_participant_voice_events"])
    expect(catalog.indexes).toHaveLength(4)
    expect(catalog.columns.map((column) => column.name)).toContain("workspace_id")
    expect(sql).not.toMatch(/DROP|REFERENCES|ALTER TABLE research_voice/i)
    const runner = readFileSync(new URL("../lib/migrations/runner.ts", import.meta.url), "utf8")
    expect(runner).toContain('name: "049_research_participant_voice"')
  })
})
