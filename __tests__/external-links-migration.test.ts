import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

// Static guards for 126_external_links: the SQL file is what reaches Aurora DSQL.
const ROOT = process.cwd()
const NAME = "126_external_links"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const raw = existsSync(sqlPath) ? readFileSync(sqlPath, "utf-8") : ""
const sql = raw.split("\n").map(function (line) { return line.split("--")[0] }).join("\n")
const statements = sql.split(";").map(function (s) { return s.trim() }).filter(Boolean)

describe(NAME, function () {
  it("is registered exactly once, after 125_unified_conversations", function () {
    expect(runner.split('name: "' + NAME + '"').length - 1).toBe(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf('name: "' + NAME + '"')).toBeGreaterThan(runner.indexOf('name: "125_unified_conversations"'))
  })

  it("is one idempotent table and two async indexes", function () {
    expect(statements).toHaveLength(3)
    expect(statements[0]).toMatch(/^CREATE TABLE IF NOT EXISTS external_links\s*\(/i)
    expect(statements[1]).toBe("CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_external_links_subject_key ON external_links(subject_type, subject_id, provider, external_key_hash)")
    expect(statements[2]).toBe("CREATE INDEX ASYNC IF NOT EXISTS idx_external_links_workspace_key ON external_links(workspace_id, provider, external_key_hash)")
  })

  it("uses no foreign keys, enums, triggers, alters, serials or index ordering", function () {
    const upper = sql.toUpperCase()
    for (const forbidden of ["REFERENCES", "CREATE TYPE", "CREATE TRIGGER", "ALTER TABLE", "SERIAL", " ASC", " DESC", " WHERE "]) {
      expect(upper).not.toContain(forbidden)
    }
  })

  it("keeps the unique key inside a btree entry", function () {
    expect(statements[0]).toContain("url VARCHAR(1000) NOT NULL")
    expect(statements[0]).toContain("external_key VARCHAR(1000) NOT NULL")
    expect(statements[0]).toContain("external_key_hash VARCHAR(64) NOT NULL")
    // Even four UTF-8 bytes per declared VARCHAR character stays below DSQL's 1 KiB key limit.
    expect(4 * (40 + 30 + 64) + 16).toBeLessThan(1024)
  })

})
