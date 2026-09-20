import { describe, expect, it } from "vitest"
import type { PoolClient } from "pg"

import {
  AGENT_SCOPED_OAUTH_COLUMNS,
  AGENT_SCOPED_OAUTH_INDEXES,
  assertAgentScopedOAuthBindingMigration,
} from "@/lib/migrations/agent-scoped-oauth-binding"

type ColumnRow = { table_name: string; column_name: string; is_nullable: string }
type IndexRow = { name: string; valid: boolean }

const HEALTHY_COLUMNS: ColumnRow[] = AGENT_SCOPED_OAUTH_COLUMNS.map((qualified) => {
  const [table_name, column_name] = qualified.split(".")
  return { table_name, column_name, is_nullable: "YES" }
})

const HEALTHY_INDEXES: IndexRow[] = AGENT_SCOPED_OAUTH_INDEXES.map((name) => ({ name, valid: true }))

/**
 * @param nullCounts table.column → how many rows the backfill left NULL.
 *   Absent means zero, i.e. the backfill finished.
 */
function fakeClient(
  options: {
    columns?: ColumnRow[]
    indexes?: IndexRow[]
    nullCounts?: Record<string, string>
  } = {},
) {
  return {
    query: async (sql: string) => {
      if (/information_schema\.columns/i.test(sql)) return { rows: options.columns ?? HEALTHY_COLUMNS }
      if (/pg_index/i.test(sql)) return { rows: options.indexes ?? HEALTHY_INDEXES }
      // The backfill probes are `SELECT count(*) … WHERE "col" IS NULL`.
      const match = /FROM "[^"]+"\."([^"]+)" WHERE "([^"]+)" IS NULL/.exec(sql)
      if (!match) throw new Error(`unexpected query: ${sql}`)
      return { rows: [{ count: options.nullCounts?.[`${match[1]}.${match[2]}`] ?? "0" }] }
    },
  } as unknown as PoolClient
}

describe("assertAgentScopedOAuthBindingMigration", () => {
  it("passes on a complete catalog with the backfill finished", async () => {
    await expect(
      assertAgentScopedOAuthBindingMigration(fakeClient(), "compass_dev"),
    ).resolves.toBeUndefined()
  })

  it("covers exactly the columns ADR 0015 specifies, across all four tables", async () => {
    expect([...AGENT_SCOPED_OAUTH_COLUMNS].sort()).toEqual(
      [
        "agent_tool_calls.credential_type",
        "oauth_authorization_codes.agent_id",
        "oauth_authorization_codes.authorization_mode",
        "oauth_consents.agent_id",
        "oauth_consents.authorization_mode",
        "oauth_tokens.agent_id",
        "oauth_tokens.authorization_mode",
      ].sort(),
    )
  })

  it.each([...AGENT_SCOPED_OAUTH_COLUMNS])("fails when %s is missing", async (missing) => {
    await expect(
      assertAgentScopedOAuthBindingMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.filter((c) => `${c.table_name}.${c.column_name}` !== missing),
        }),
        "compass_dev",
      ),
    ).rejects.toThrow(new RegExp(`missing column\\(s\\).*${missing.replace(".", "\\.")}`))
  })

  it.each([...AGENT_SCOPED_OAUTH_COLUMNS])("fails when %s came out NOT NULL", async (column) => {
    // DSQL cannot add a NOT NULL column to a populated table without a DEFAULT,
    // and it rejects DEFAULT on ADD COLUMN — so a NOT NULL here would mean the
    // migration ran as something other than what is checked in.
    await expect(
      assertAgentScopedOAuthBindingMigration(
        fakeClient({
          columns: HEALTHY_COLUMNS.map((c) =>
            `${c.table_name}.${c.column_name}` === column ? { ...c, is_nullable: "NO" } : c,
          ),
        }),
        "compass_dev",
      ),
    ).rejects.toThrow(/must be nullable/)
  })

  it.each([
    "oauth_authorization_codes.authorization_mode",
    "oauth_tokens.authorization_mode",
    "oauth_consents.authorization_mode",
    "agent_tool_calls.credential_type",
  ])("fails when the %s backfill left rows behind", async (column) => {
    // The "never null" property comes from an UPDATE, not from the schema, so
    // the receipt must not be written while rows still hold NULL.
    await expect(
      assertAgentScopedOAuthBindingMigration(
        fakeClient({ nullCounts: { [column]: "3" } }),
        "compass_dev",
      ),
    ).rejects.toThrow(new RegExp(`${column.replace(".", "\\.")} still has 3 unbackfilled row\\(s\\)`))
  })

  it("does not demand a backfill of agent_id, whose null is the common case", async () => {
    // Every USER-mode row has a null agent_id. Requiring a value there would be
    // requiring the override to name an agent, which is the opposite of what it
    // means — and is exactly why the mode needs its own column.
    await expect(
      assertAgentScopedOAuthBindingMigration(
        fakeClient({ nullCounts: { "oauth_tokens.agent_id": "9000" } }),
        "compass_dev",
      ),
    ).resolves.toBeUndefined()
  })

  it.each([...AGENT_SCOPED_OAUTH_INDEXES])("fails when index %s is missing", async (missing) => {
    await expect(
      assertAgentScopedOAuthBindingMigration(
        fakeClient({ indexes: HEALTHY_INDEXES.filter((i) => i.name !== missing) }),
        "compass_dev",
      ),
    ).rejects.toThrow(new RegExp(`not valid: .*${missing}`))
  })

  it.each([...AGENT_SCOPED_OAUTH_INDEXES])(
    "fails when ASYNC index %s exists but never became valid",
    async (name) => {
      // sys.wait_for_job timed out, indisvalid = false, and a finished receipt
      // would hide it forever.
      await expect(
        assertAgentScopedOAuthBindingMigration(
          fakeClient({ indexes: HEALTHY_INDEXES.map((i) => (i.name === name ? { ...i, valid: false } : i)) }),
          "compass_dev",
        ),
      ).rejects.toThrow(new RegExp(`not valid: .*${name}`))
    },
  )

  it("scopes every query to the schema it was handed", async () => {
    const statements: string[] = []
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        statements.push(sql)
        if (/information_schema\.columns/i.test(sql)) {
          expect(params?.[0]).toBe("compass_preview")
          return { rows: HEALTHY_COLUMNS }
        }
        if (/pg_index/i.test(sql)) {
          expect(params?.[0]).toBe("compass_preview")
          return { rows: HEALTHY_INDEXES }
        }
        // Backfill probes interpolate the schema, so assert it textually.
        expect(sql).toContain('"compass_preview".')
        return { rows: [{ count: "0" }] }
      },
    } as unknown as PoolClient
    await assertAgentScopedOAuthBindingMigration(client, "compass_preview")
    // 1 column catalog + 4 backfill probes + 1 index catalog.
    expect(statements).toHaveLength(6)
  })
})

describe("056 migration SQL", () => {
  it("obeys the DSQL rules the runner and the cluster both depend on", async () => {
    const { readFileSync } = await import("node:fs")
    const sql = readFileSync("prisma/migrations/056_agent_scoped_oauth_binding/migration.sql", "utf8")
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--") && line.trim())
      .join("\n")

    // DSQL rejects a DEFAULT (or any constraint) on ALTER TABLE ADD COLUMN, so
    // the "never null" property has to come from the separate UPDATEs below.
    for (const add of statements.match(/ALTER TABLE[^;]+ADD COLUMN[^;]+;/g) ?? []) {
      expect(add).toMatch(/ADD COLUMN IF NOT EXISTS/)
      expect(add).not.toMatch(/\bDEFAULT\b|\bNOT NULL\b/)
    }
    expect(statements.match(/ALTER TABLE/g)).toHaveLength(7)

    // Idempotent on rerun: the runner resumes after an async-index timeout, so
    // no statement may fail or double-apply on a second pass.
    for (const update of statements.match(/UPDATE[^;]+;/g) ?? []) {
      expect(update).toMatch(/IS NULL/)
    }
    expect(statements.match(/UPDATE/g)).toHaveLength(4)

    // The only index form DSQL accepts.
    expect(statements).toContain("CREATE INDEX ASYNC IF NOT EXISTS idx_oauth_tokens_agent")
    expect(statements).not.toMatch(/CREATE\s+(?:UNIQUE\s+)?INDEX(?!\s+ASYNC)/)

    // No FKs (relationMode = "prisma"), and no explicit transaction blocks —
    // one implicit DDL transaction per statement, matching 052 through 055.
    expect(statements).not.toMatch(/FOREIGN KEY|REFERENCES/i)
    expect(statements).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im)

    // Out of scope for this stage, and destructive if it slipped in early: the
    // forced re-consent revoke/purge must land with the consent screen that can
    // mint a replacement, not before it.
    expect(statements).not.toMatch(/DELETE\s+FROM|revoked_at\s*=/i)
  })
})

describe("migration 056 registration", () => {
  /**
   * The runner needs 056 in four separate places, and each omission fails in a
   * different, quiet way. 055 is the precedent that established all four.
   */
  it("is registered in all four places the runner needs it", async () => {
    const { readFileSync } = await import("node:fs")
    const runner = readFileSync("lib/migrations/runner.ts", "utf8")

    // 1. The manifest, under its exact name — the runner keys on the name, never
    //    on the leading number, which is why duplicate numbers are tolerated here.
    expect(runner).toContain('name: "056_agent_scoped_oauth_binding"')
    expect(runner).toContain("prisma/migrations/056_agent_scoped_oauth_binding/migration.sql")

    // 2. ASYNC_WAIT_MIGRATIONS — without it the runner never calls
    //    sys.wait_for_job, so the receipt lands while the index is still building.
    expect(runner).toMatch(/ASYNC_WAIT_MIGRATIONS[\s\S]{0,600}056_agent_scoped_oauth_binding/)

    // 3. The no-job_id resume list. CREATE INDEX ASYNC IF NOT EXISTS returns no
    //    job on a rerun where the index already exists; without this the resume
    //    POST throws "async DDL returned no job_id" and can never finish.
    expect(runner).toMatch(/if \(!jobId &&[\s\S]{0,400}056_agent_scoped_oauth_binding/)

    // 4. The postcondition, before the receipt write.
    expect(runner).toMatch(
      /migration\.name === "056_agent_scoped_oauth_binding"[\s\S]{0,120}assertAgentScopedOAuthBindingMigration/,
    )
  })

  it("does not renumber or disturb the existing duplicate-number migrations", async () => {
    const { readFileSync } = await import("node:fs")
    const runner = readFileSync("lib/migrations/runner.ts", "utf8")
    // Both 054s and both 055s are already applied under these exact names in
    // the shared compass_preview schema. Renaming one orphans its receipt and
    // re-runs its DDL.
    for (const name of [
      "054_research_study_artifact",
      "054_workspace_wip_limits",
      "055_workspace_launch_workflow_flag",
      "055_oauth_authorization_server",
    ]) {
      expect(runner).toContain(`name: "${name}"`)
    }
  })
})
