import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 068_follows_notifications (ADR "Following and in-app
 * notifications", slice 1). The DDL that reaches Aurora DSQL is this SQL file,
 * not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "068_follows_notifications"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
  })

  it("is one idempotent statement per DDL: two tables, then five async indexes", () => {
    expect(statements).toHaveLength(7)
    expect(statements.slice(0, 2).every((s) => /^CREATE TABLE IF NOT EXISTS "?(follows|notifications)"?\s*\(/i.test(s))).toBe(true)
    for (const statement of statements.slice(2)) {
      expect(statement).toMatch(/^CREATE (UNIQUE )?INDEX ASYNC IF NOT EXISTS idx_(follows|notifications)_\w+ ON (follows|notifications)\(/i)
    }
  })

  it("uses no foreign keys, enums, triggers, defaults-on-alter or partial indexes", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|ALTER TABLE|\bWHERE\b|SERIAL/i)
  })

  it("carries the ADR columns and a NOT NULL dedupe key", () => {
    const follows = statements[0]
    for (const column of ["workspace_id", "user_id", "subject_type", "subject_id", "state", "source", "created_at", "updated_at"]) {
      expect(follows).toContain(column)
    }
    const notifications = statements[1]
    for (const column of ["workspace_id", "recipient_user_id", "subject_type", "subject_id", "kind", "actor_type", "actor_id", "payload", "dedupe_key", "read_at", "created_at"]) {
      expect(notifications).toContain(column)
    }
    expect(notifications).toMatch(/dedupe_key\s+VARCHAR\(\d+\)\s+NOT NULL/i)
    expect(notifications).toMatch(/actor_id\s+UUID\s*,/i)
  })

  it("builds the ADR indexes", () => {
    expect(sql).toMatch(/UNIQUE INDEX ASYNC IF NOT EXISTS idx_follows_user_subject ON follows\(user_id, subject_type, subject_id\)/)
    expect(sql).toMatch(/INDEX ASYNC IF NOT EXISTS idx_follows_subject ON follows\(subject_type, subject_id\)/)
    expect(sql).toMatch(/INDEX ASYNC IF NOT EXISTS idx_follows_workspace_user ON follows\(workspace_id, user_id\)/)
    expect(sql).toMatch(/UNIQUE INDEX ASYNC IF NOT EXISTS idx_notifications_recipient_dedupe ON notifications\(recipient_user_id, dedupe_key\)/)
    expect(sql).toMatch(/INDEX ASYNC IF NOT EXISTS idx_notifications_inbox ON notifications\(workspace_id, recipient_user_id, created_at\)/)
  })

  it("maps the same tables and index names in schema.prisma", () => {
    expect(schema).toContain('@@map("follows")')
    expect(schema).toContain('@@map("notifications")')
    for (const name of ["idx_follows_user_subject", "idx_follows_subject", "idx_follows_workspace_user", "idx_notifications_recipient_dedupe", "idx_notifications_inbox"]) {
      expect(schema).toContain(`map: "${name}"`)
    }
    expect(schema).not.toMatch(/model (Follow|Notification) \{[^}]*@relation/)
  })

  it("waits for its async indexes, can resume, and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"068_follows_notifications"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"068_follows_notifications"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "068_follows_notifications") await assertFollowsNotificationsMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
