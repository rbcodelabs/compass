import { describe, expect, it } from "vitest"
import type { PoolClient } from "pg"

import {
  OAUTH_AUTHORIZATION_SERVER_COLUMNS,
  OAUTH_AUTHORIZATION_SERVER_INDEXES,
  OAUTH_AUTHORIZATION_SERVER_TABLES,
  assertOAuthAuthorizationServerMigration,
} from "@/lib/migrations/oauth-authorization-server"

type ColumnRow = { table_name: string; column_name: string; is_nullable: string }
type IndexRow = { name: string; valid: boolean; unique: boolean }

const UNIQUE = new Set([
  "idx_oauth_clients_client_id",
  "idx_oauth_authorization_codes_hash",
  "idx_oauth_tokens_hash",
  "idx_oauth_consents_user_client",
])

const HEALTHY_COLUMNS: ColumnRow[] = OAUTH_AUTHORIZATION_SERVER_COLUMNS.map((qualified) => {
  const [table_name, column_name] = qualified.split(".")
  return { table_name, column_name, is_nullable: "YES" }
})

const HEALTHY_INDEXES: IndexRow[] = OAUTH_AUTHORIZATION_SERVER_INDEXES.map((name) => ({
  name,
  valid: true,
  unique: UNIQUE.has(name),
}))

function fakeClient(options: { columns?: ColumnRow[]; indexes?: IndexRow[] } = {}) {
  return {
    query: async (sql: string) =>
      /information_schema\.columns/i.test(sql)
        ? { rows: options.columns ?? HEALTHY_COLUMNS }
        : { rows: options.indexes ?? HEALTHY_INDEXES },
  } as unknown as PoolClient
}

describe("assertOAuthAuthorizationServerMigration", () => {
  it("passes on a complete, valid catalog", async () => {
    await expect(
      assertOAuthAuthorizationServerMigration(fakeClient(), "compass_dev"),
    ).resolves.toBeUndefined()
  })

  it("covers all four tables the design specifies", () => {
    expect([...OAUTH_AUTHORIZATION_SERVER_TABLES]).toEqual([
      "oauth_clients",
      "oauth_authorization_codes",
      "oauth_tokens",
      "oauth_consents",
    ])
    for (const table of OAUTH_AUTHORIZATION_SERVER_TABLES) {
      expect(OAUTH_AUTHORIZATION_SERVER_COLUMNS.some((c) => c.startsWith(`${table}.`))).toBe(true)
    }
  })

  it.each([...OAUTH_AUTHORIZATION_SERVER_COLUMNS])("fails when %s is missing", async (missing) => {
    await expect(
      assertOAuthAuthorizationServerMigration(
        fakeClient({ columns: HEALTHY_COLUMNS.filter((c) => `${c.table_name}.${c.column_name}` !== missing) }),
        "compass_dev",
      ),
    ).rejects.toThrow(new RegExp(`missing column\\(s\\).*${missing.replace(".", "\\.")}`))
  })

  it("fails when a whole table never got created", async () => {
    await expect(
      assertOAuthAuthorizationServerMigration(
        fakeClient({ columns: HEALTHY_COLUMNS.filter((c) => c.table_name !== "oauth_tokens") }),
        "compass_dev",
      ),
    ).rejects.toThrow(/missing column\(s\).*oauth_tokens\.token_hash/)
  })

  it.each([
    "oauth_clients.client_secret_hash",
    "oauth_clients.last_used_at",
    "oauth_authorization_codes.consumed_at",
    "oauth_tokens.revoked_at",
    "oauth_tokens.scope_workspace_id",
    "oauth_tokens.parent_token_id",
    "oauth_tokens.last_used_at",
  ])("fails when the lifecycle column %s came out NOT NULL", async (column) => {
    await expect(
      assertOAuthAuthorizationServerMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.map((c) =>
            `${c.table_name}.${c.column_name}` === column ? { ...c, is_nullable: "NO" } : c,
          ),
        }),
        "compass_dev",
      ),
    ).rejects.toThrow(/must be nullable/)
  })

  it.each([...OAUTH_AUTHORIZATION_SERVER_INDEXES])("fails when index %s is missing", async (missing) => {
    await expect(
      assertOAuthAuthorizationServerMigration(
        fakeClient({ indexes: HEALTHY_INDEXES.filter((i) => i.name !== missing) }),
        "compass_dev",
      ),
    ).rejects.toThrow(new RegExp(`not valid: .*${missing}`))
  })

  it.each([...OAUTH_AUTHORIZATION_SERVER_INDEXES])(
    "fails when ASYNC index %s exists but never became valid",
    async (name) => {
      // The real DSQL failure mode: sys.wait_for_job timed out, the index row
      // exists with indisvalid = false, and a finished receipt would hide it.
      await expect(
        assertOAuthAuthorizationServerMigration(
          fakeClient({ indexes: HEALTHY_INDEXES.map((i) => (i.name === name ? { ...i, valid: false } : i)) }),
          "compass_dev",
        ),
      ).rejects.toThrow(new RegExp(`not valid: .*${name}`))
    },
  )

  it.each([...UNIQUE])("fails when %s came back valid but not UNIQUE", async (name) => {
    // A non-unique token_hash index lets the token endpoint mint two rows for
    // one hash, which no downstream lookup can detect.
    await expect(
      assertOAuthAuthorizationServerMigration(
        fakeClient({ indexes: HEALTHY_INDEXES.map((i) => (i.name === name ? { ...i, unique: false } : i)) }),
        "compass_dev",
      ),
    ).rejects.toThrow(new RegExp(`must be UNIQUE: .*${name}`))
  })

  it("does not require the non-unique indexes to be unique", async () => {
    const nonUnique = OAUTH_AUTHORIZATION_SERVER_INDEXES.filter((name) => !UNIQUE.has(name))
    expect(nonUnique.length).toBeGreaterThan(0)
    await expect(
      assertOAuthAuthorizationServerMigration(fakeClient(), "compass_dev"),
    ).resolves.toBeUndefined()
  })

  it("scopes its catalog query to the schema it was handed", async () => {
    const seen: unknown[][] = []
    const client = {
      query: async (sql: string, params: unknown[]) => {
        seen.push(params)
        return /information_schema\.columns/i.test(sql)
          ? { rows: HEALTHY_COLUMNS }
          : { rows: HEALTHY_INDEXES }
      },
    } as unknown as PoolClient
    await assertOAuthAuthorizationServerMigration(client, "compass_preview")
    expect(seen).toHaveLength(2)
    for (const params of seen) expect(params[0]).toBe("compass_preview")
  })
})
