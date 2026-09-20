import { readFileSync } from "node:fs"

import type { PoolClient } from "pg"
import { describe, expect, it } from "vitest"

import {
  assertOAuthAuthorizationEventsMigration,
  OAUTH_AUTHORIZATION_EVENT_COLUMNS,
  OAUTH_AUTHORIZATION_EVENT_INDEXES,
} from "@/lib/migrations/oauth-authorization-events"

function fakeClient(options: { missingColumn?: string; invalidIndex?: string; nonUniqueCodeIndex?: boolean } = {}) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("information_schema.columns")) {
        return {
          rows: OAUTH_AUTHORIZATION_EVENT_COLUMNS
            .filter((name) => name !== options.missingColumn)
            .map((name) => {
              const [, column_name] = name.split(".")
              return {
                table_name: "oauth_authorization_events",
                column_name,
                is_nullable: column_name === "agent_id" ? "YES" : "NO",
              }
            }),
        }
      }
      if (sql.includes("pg_index")) {
        return {
          rows: OAUTH_AUTHORIZATION_EVENT_INDEXES.map((name) => ({
            name,
            valid: name !== options.invalidIndex,
            unique: name === "idx_oauth_authorization_events_code" && !options.nonUniqueCodeIndex,
          })),
        }
      }
      throw new Error(`unexpected query ${sql} ${JSON.stringify(params)}`)
    },
  } as unknown as PoolClient
}

describe("assertOAuthAuthorizationEventsMigration", () => {
  it("passes only with the complete table and valid indexes", async () => {
    await expect(
      assertOAuthAuthorizationEventsMigration(fakeClient(), "compass_dev"),
    ).resolves.toBeUndefined()
  })

  it("fails closed for a missing column", async () => {
    await expect(
      assertOAuthAuthorizationEventsMigration(
        fakeClient({ missingColumn: "oauth_authorization_events.redirect_origin" }),
        "compass_dev",
      ),
    ).rejects.toThrow("missing column(s) oauth_authorization_events.redirect_origin")
  })

  it("fails closed for an invalid or non-unique correctness index", async () => {
    await expect(
      assertOAuthAuthorizationEventsMigration(
        fakeClient({ invalidIndex: "idx_oauth_authorization_events_user_created" }),
        "compass_dev",
      ),
    ).rejects.toThrow("index(es) missing or not valid")
    await expect(
      assertOAuthAuthorizationEventsMigration(fakeClient({ nonUniqueCodeIndex: true }), "compass_dev"),
    ).rejects.toThrow("authorization-code index must be UNIQUE")
  })
})

describe("migration 058 registration", () => {
  it("registers after 057, waits for indexes, and checks postconditions before receipt", () => {
    const runner = readFileSync("lib/migrations/runner.ts", "utf8")
    expect(runner).toContain('name: "058_oauth_authorization_events"')
    expect(runner.indexOf('name: "058_oauth_authorization_events"')).toBeGreaterThan(
      runner.indexOf('name: "057_oauth_forced_reconsent"'),
    )
    expect(runner).toMatch(/ASYNC_WAIT_MIGRATIONS[\s\S]*058_oauth_authorization_events/)

    const loopStart = runner.indexOf("for (const migration of toRun)")
    const postcondition = runner.indexOf(
      'migration.name === "058_oauth_authorization_events"',
      loopStart,
    )
    const receipt = runner.indexOf(
      'UPDATE "${schema}"._prisma_migrations SET finished_at = CURRENT_TIMESTAMP',
      loopStart,
    )
    expect(postcondition).toBeGreaterThan(loopStart)
    expect(receipt).toBeGreaterThan(postcondition)
  })
})

describe("058 migration SQL", () => {
  it("creates the narrow event table and its three DSQL indexes without foreign keys", () => {
    const sql = readFileSync("prisma/migrations/058_oauth_authorization_events/migration.sql", "utf8")
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS oauth_authorization_events/)
    for (const column of [
      "event_type",
      "source",
      "authorization_code_id",
      "user_id",
      "client_id",
      "client_name_snapshot",
      "redirect_origin",
      "authorization_mode",
      "agent_id",
      "scope",
      "created_at",
    ]) expect(sql).toContain(column)
    expect(sql).toMatch(/CREATE UNIQUE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_events_code/)
    expect(sql).toMatch(/CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_events_user_created/)
    expect(sql).toMatch(/CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_authorization_events_client_created/)
    expect(sql).not.toMatch(/FOREIGN KEY|REFERENCES/i)
  })
})
