import { readFileSync } from "node:fs"

import type { PoolClient } from "pg"
import { describe, expect, it } from "vitest"

import { assertOAuthForcedReconsentMigration } from "@/lib/migrations/oauth-forced-reconsent"

function fakeClient(counts: { liveTokens?: string; consents?: string; authorizationCodes?: string } = {}) {
  return {
    query: async (sql: string) => {
      if (/FROM "[^"]+"\."oauth_tokens" WHERE revoked_at IS NULL/i.test(sql)) {
        return { rows: [{ count: counts.liveTokens ?? "0" }] }
      }
      if (/FROM "[^"]+"\."oauth_consents"/i.test(sql)) {
        return { rows: [{ count: counts.consents ?? "0" }] }
      }
      if (/FROM "[^"]+"\."oauth_authorization_codes"/i.test(sql)) {
        return { rows: [{ count: counts.authorizationCodes ?? "0" }] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
  } as unknown as PoolClient
}

describe("assertOAuthForcedReconsentMigration", () => {
  it("passes only after every live token is revoked and every consent and code is deleted", async () => {
    await expect(assertOAuthForcedReconsentMigration(fakeClient(), "compass_dev")).resolves.toBeUndefined()
  })

  it("fails while an unrevoked OAuth token remains", async () => {
    await expect(
      assertOAuthForcedReconsentMigration(fakeClient({ liveTokens: "2" }), "compass_dev"),
    ).rejects.toThrow("Migration 057 postcondition failed: 2 unrevoked OAuth token(s) remain.")
  })

  it("fails while a remembered OAuth consent remains", async () => {
    await expect(
      assertOAuthForcedReconsentMigration(fakeClient({ consents: "3" }), "compass_dev"),
    ).rejects.toThrow("Migration 057 postcondition failed: 3 OAuth consent(s) remain.")
  })

  it("fails while an outstanding OAuth authorization code remains", async () => {
    await expect(
      assertOAuthForcedReconsentMigration(fakeClient({ authorizationCodes: "1" }), "compass_dev"),
    ).rejects.toThrow("Migration 057 postcondition failed: 1 OAuth authorization code(s) remain.")
  })

  it("scopes both probes to the active schema", async () => {
    const statements: string[] = []
    const client = {
      query: async (sql: string) => {
        statements.push(sql)
        expect(sql).toContain('FROM "compass_preview".')
        return { rows: [{ count: "0" }] }
      },
    } as unknown as PoolClient

    await assertOAuthForcedReconsentMigration(client, "compass_preview")
    expect(statements).toHaveLength(3)
  })
})

describe("migration 057 registration", () => {
  it("runs the postcondition after destructive SQL and before writing the receipt", () => {
    const runner = readFileSync("lib/migrations/runner.ts", "utf8")
    expect(runner).toContain('name: "057_oauth_forced_reconsent"')
    expect(runner).toContain("prisma/migrations/057_oauth_forced_reconsent/migration.sql")
    expect(runner.indexOf('name: "057_oauth_forced_reconsent"')).toBeGreaterThan(
      runner.indexOf('name: "056_agent_scoped_oauth_binding"'),
    )

    const loopStart = runner.indexOf("for (const migration of toRun)")
    const postcondition = runner.indexOf(
      'migration.name === "057_oauth_forced_reconsent"',
      loopStart,
    )
    const receipt = runner.indexOf(
      'UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP',
      loopStart,
    )

    expect(loopStart).toBeGreaterThan(-1)
    expect(postcondition).toBeGreaterThan(loopStart)
    expect(receipt).toBeGreaterThan(postcondition)
  })
})

describe("057 migration SQL", () => {
  it("revokes only live OAuth tokens and removes every remembered consent and outstanding code", () => {
    const sql = readFileSync("prisma/migrations/057_oauth_forced_reconsent/migration.sql", "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--") && line.trim())
      .join("\n")

    expect(sql).toMatch(/UPDATE oauth_tokens SET revoked_at = now\(\) WHERE revoked_at IS NULL;/)
    expect(sql).toMatch(/DELETE FROM oauth_consents;/)
    expect(sql).toMatch(/DELETE FROM oauth_authorization_codes;/)
    expect(sql.match(/;/g)).toHaveLength(3)
  })
})
