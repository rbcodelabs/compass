import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Static guards for 105_artifact_external_share. The DDL that reaches Aurora DSQL is the SQL
 * file, not schema.prisma, so the two are pinned to each other here.
 */
const ROOT = process.cwd()
const NAME = "105_artifact_external_share"
const runner = readFileSync(path.join(ROOT, "lib/migrations/runner.ts"), "utf-8")
const schema = readFileSync(path.join(ROOT, "prisma/schema.prisma"), "utf-8")
const sqlPath = path.join(ROOT, "prisma/migrations", NAME, "migration.sql")
const sql = existsSync(sqlPath)
  ? readFileSync(sqlPath, "utf-8").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n")
  : ""
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)

describe(NAME, () => {
  it("is registered exactly once, directly after 081", () => {
    expect([...runner.matchAll(new RegExp(`name:\\s*"${NAME}"`, "g"))]).toHaveLength(1)
    expect(existsSync(sqlPath)).toBe(true)
    expect(runner.indexOf(`name: "${NAME}"`)).toBeGreaterThan(runner.indexOf('name: "081_v0_chat_artifacts"'))
  })

  it("only creates tables and async indexes, never touching existing tables", () => {
    expect(statements).toHaveLength(11)
    for (const statement of statements) {
      expect(statement).toMatch(/^(CREATE TABLE IF NOT EXISTS artifact_share|CREATE (UNIQUE )?INDEX ASYNC IF NOT EXISTS idx_artifact_share)/i)
    }
    expect(sql).not.toMatch(/\bALTER\b/i)
  })

  it("uses no foreign keys, enums, triggers, partial indexes or backfill", () => {
    expect(sql).not.toMatch(/REFERENCES|CREATE TYPE|CREATE TRIGGER|\bWHERE\b|SERIAL|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bASC\b|\bDESC\b/i)
  })

  it("keeps secrets as hashes and only the expected columns nullable", () => {
    const shares = statements[0]
    expect(shares).toMatch(/token_hash\s+VARCHAR\(64\)\s+NOT NULL/i)
    expect(shares).toMatch(/password_hash\s+VARCHAR\(255\)\s+NOT NULL/i)
    expect(shares).toMatch(/comments_enabled\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+false/i)
    expect(shares).toMatch(/revoked_at\s+TIMESTAMP\(3\),/i)
    expect(shares).toMatch(/failed_window_at\s+TIMESTAMP\(3\),/i)
    // Raw tokens/passwords must never get a column.
    expect(sql).not.toMatch(/\b(raw_token|token|password)\s+(VARCHAR|TEXT)/i)
  })

  it("maps the same tables and indexes in schema.prisma", () => {
    for (const table of ["artifact_shares", "artifact_share_sessions", "artifact_share_commenters", "artifact_share_events"]) {
      expect(schema).toContain(`@@map("${table}")`)
    }
    for (const index of [...sql.matchAll(/INDEX ASYNC IF NOT EXISTS (\w+)/g)].map((m) => m[1])) {
      expect(schema).toContain(`map: "${index}"`)
    }
    expect(schema).not.toMatch(/model ArtifactShare\w* \{[^}]*@updatedAt/)
  })

  it("does not add anything to Artifact (deploy-order safe)", () => {
    const artifact = schema.match(/model Artifact \{[\s\S]*?\n\}/)?.[0] ?? ""
    expect(artifact).not.toMatch(/share/i)
  })

  it("waits for its async indexes and verifies before the receipt", () => {
    expect(runner).toMatch(/const ASYNC_WAIT_MIGRATIONS = \[[^\]]*"105_artifact_external_share"/)
    expect(runner).toMatch(/\["049_agent_identity"[^\]]*"105_artifact_external_share"[^\]]*\]\.includes\(migration\.name\)/)
    const assertion = runner.indexOf('migration.name === "105_artifact_external_share") await assertArtifactExternalShareMigration')
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion).toBeLessThan(runner.indexOf('UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP'))
  })
})
