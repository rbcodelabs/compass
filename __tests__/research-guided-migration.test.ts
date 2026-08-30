import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("migration 037 guided UX persistence", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "prisma/migrations/037_research_guided_ux/migration.sql"),
    "utf8",
  )

  it("creates normalized private attachment and voice-event provenance without foreign keys", () => {
    expect(sql).toContain("CREATE TABLE research_attachments")
    expect(sql).toContain("CREATE TABLE research_voice_events")
    expect(sql).toContain("voice_lease_id")
    expect(sql).not.toMatch(/FOREIGN\s+KEY/i)
  })

  it("uses only async indexes and exposes all required tenant/idempotency access paths", () => {
    const createIndexes = sql.match(/CREATE (?:UNIQUE )?INDEX[^;]+;/gi) ?? []
    expect(createIndexes.length).toBeGreaterThanOrEqual(7)
    expect(createIndexes.every((statement) => /INDEX ASYNC/i.test(statement))).toBe(true)
    expect(sql).toContain("idx_research_attachments_session_key")
    expect(sql).toContain("idx_research_attachments_blob_pathname")
    expect(sql).toContain("idx_research_voice_events_session_provider")
  })
})
