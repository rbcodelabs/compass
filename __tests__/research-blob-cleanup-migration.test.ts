import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

describe("migration 038 research blob cleanup", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "prisma/migrations/038_research_blob_cleanup/migration.sql"),
    "utf8",
  )

  it("creates a standalone tenant-scoped cleanup queue without artifact dependencies", () => {
    expect(sql).toContain("CREATE TABLE research_blob_cleanups")
    expect(sql).toContain("workspace_id UUID NOT NULL")
    expect(sql).toContain("study_id UUID NOT NULL")
    expect(sql).toContain("session_id UUID NOT NULL")
    expect(sql).toContain("attachment_id UUID NOT NULL")
    expect(sql).not.toMatch(/artifact_blob_cleanups|FOREIGN\s+KEY/i)
  })

  it("uses only async indexes for pathname uniqueness and tenant retry scans", () => {
    const createIndexes = sql.match(/CREATE (?:UNIQUE )?INDEX[^;]+;/gi) ?? []
    expect(createIndexes).toHaveLength(2)
    expect(createIndexes.every((statement) => /INDEX ASYNC/i.test(statement))).toBe(true)
    expect(sql).toContain("idx_research_blob_cleanups_pathname")
    expect(sql).toContain("idx_research_blob_cleanups_workspace_retry")
  })
})
