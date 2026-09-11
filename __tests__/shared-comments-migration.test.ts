import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const sql = readFileSync("prisma/migrations/046_shared_comments/migration.sql", "utf8")
const backfill = readFileSync("scripts/backfill-shared-comments.ts", "utf8")

describe("shared comments DSQL migration", () => {
  it("keeps schema changes additive and indexes asynchronous", () => {
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS comments")
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i)
    expect(sql.match(/CREATE INDEX ASYNC/g)).toHaveLength(3)
  })

  it("does not put an unbounded legacy backfill in the DDL migration", () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+comments/i)
    expect(backfill).toContain("const BATCH_SIZE = 500")
    expect(backfill).toContain("skipDuplicates: true")
  })
})
