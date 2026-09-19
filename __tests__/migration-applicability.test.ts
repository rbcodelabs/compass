import { describe, expect, it, vi } from "vitest"
import type { Pool, PoolClient } from "pg"

vi.mock("@/lib/migrations/legacy-decision-review-repair", () => ({
  getLegacyDecisionReviewRepairStatus: vi.fn().mockResolvedValue({ workspaceStatus: "NOT_PRESENT", requests: [] }),
  applyLegacyDecisionReviewRepair: vi.fn().mockResolvedValue({ workspaceStatus: "NOT_PRESENT", requests: [] }),
  LEGACY_DECISION_REVIEW_REPAIR_MIGRATION: "048_legacy_decision_review_repair",
}))

import {
  applyMigrations,
  getDecisionGateExpectedCatalog,
  getDecisionGateInfrastructureHealth,
  getMigrationStatus,
  partitionPendingMigrations,
  resolveSchemaEnvironment,
  satisfyingAlternative,
} from "@/lib/migrations/runner"

const PREVIEW_AUTOMATION = "047_preview_automation"
const NATIVE_GATES = "039_native_decision_gates"
const GATES_REPAIR = "042_native_decision_gates_repair"

/**
 * The four columns 051_decision_task_bridge legitimately adds to
 * review_requests. COLUMN_EXPECTATIONS is parsed from 039-045 only, so these are
 * permanently "extra" relative to the expectation set and must never read as
 * drift. Asserted against the migration SQL itself in
 * __tests__/precursor-migrations.test.ts's sibling coverage; listed here as the
 * shape the production catalog actually reports.
 */
const BRIDGE_COLUMNS = ["no_action_at", "no_action_by_id", "no_action_reason", "requested_by_agent_id"] as const

describe("resolveSchemaEnvironment", () => {
  it.each([
    ["compass_prod", "production"],
    ["compass_preview", "preview"],
    ["compass_dev", "development"],
  ])("maps the default-prefixed schema %s to %s", (schema, environment) => {
    expect(resolveSchemaEnvironment(schema)).toBe(environment)
  })

  it.each([
    ["compass_pr_1_0123456789ab", "preview"],
    ["compass_pr_4821_a1b2c3d4e5f6", "preview"],
  ])("maps the isolated per-PR automation schema %s to %s", (schema, environment) => {
    expect(resolveSchemaEnvironment(schema)).toBe(environment)
  })

  it.each([
    ["acme_prod", "production"],
    ["acme_preview", "preview"],
    ["acme_dev", "development"],
    ["compass_e2e_prod", "production"],
  ])("matches the suffix only, so a PGSCHEMA prefix override like %s still resolves to %s", (schema, environment) => {
    expect(resolveSchemaEnvironment(schema)).toBe(environment)
  })

  it.each([
    "",
    "compass",
    "public",
    "compass_staging",
    "compass_production",
    "compass_pr_0_0123456789ab",
    "compass_pr_12_notvalidhex1",
    "COMPASS_PROD",
  ])("returns null for the unrecognized schema name %j rather than guessing", (schema) => {
    expect(resolveSchemaEnvironment(schema)).toBeNull()
  })
})

describe("migration applicability", () => {
  it("drops 047_preview_automation from production pending work with a stated reason", () => {
    const { environment, pending, notApplicable } = partitionPendingMigrations("compass_prod", new Set<string>())
    expect(environment).toBe("production")
    expect(pending.map((migration) => migration.name)).not.toContain(PREVIEW_AUTOMATION)
    expect(notApplicable).toContainEqual({ name: PREVIEW_AUTOMATION, reason: "scoped to development, preview" })
  })

  it.each(["compass_preview", "compass_pr_77_0123456789ab", "compass_dev"])(
    "keeps 047_preview_automation pending in %s, where the harness tables belong",
    (schema) => {
      const { pending, notApplicable } = partitionPendingMigrations(schema, new Set<string>())
      expect(pending.map((migration) => migration.name)).toContain(PREVIEW_AUTOMATION)
      expect(notApplicable.map((entry) => entry.name)).not.toContain(PREVIEW_AUTOMATION)
    },
  )

  // The safety property: a schema name the resolver cannot parse must widen the
  // applicable set, never narrow it. Silently skipping a migration because of a
  // parsing miss is the failure mode this guards.
  it("fails OPEN on an unrecognized schema name, treating every migration as applicable", () => {
    const { environment, pending, notApplicable } = partitionPendingMigrations("some_unregistered_schema", new Set<string>())
    expect(environment).toBeNull()
    expect(notApplicable).toEqual([])
    expect(pending.map((migration) => migration.name)).toContain(PREVIEW_AUTOMATION)
    const { pending: production } = partitionPendingMigrations("compass_prod", new Set<string>())
    expect(pending.length).toBeGreaterThan(production.length)
  })

  it("never reports an already-applied migration as either pending or not applicable", () => {
    const applied = new Set([PREVIEW_AUTOMATION, NATIVE_GATES])
    const { pending, notApplicable } = partitionPendingMigrations("compass_preview", applied)
    for (const name of applied) {
      expect(pending.map((migration) => migration.name)).not.toContain(name)
      expect(notApplicable.map((entry) => entry.name)).not.toContain(name)
    }
  })
})

describe("039/042 mutual alternatives", () => {
  it("retires 042 once 039 has a receipt", () => {
    const applied = new Set([NATIVE_GATES])
    expect(satisfyingAlternative(GATES_REPAIR, applied)).toBe(NATIVE_GATES)
    const { pending, notApplicable } = partitionPendingMigrations("compass_prod", applied)
    expect(pending.map((migration) => migration.name)).not.toContain(GATES_REPAIR)
    expect(notApplicable).toContainEqual({ name: GATES_REPAIR, reason: `satisfied by ${NATIVE_GATES}` })
  })

  it("retires 039 once 042 has a receipt", () => {
    const applied = new Set([GATES_REPAIR])
    expect(satisfyingAlternative(NATIVE_GATES, applied)).toBe(GATES_REPAIR)
    const { pending, notApplicable } = partitionPendingMigrations("compass_prod", applied)
    expect(pending.map((migration) => migration.name)).not.toContain(NATIVE_GATES)
    expect(notApplicable).toContainEqual({ name: NATIVE_GATES, reason: `satisfied by ${GATES_REPAIR}` })
  })

  // 042 exists for exactly one situation: 039 failed partway through. It must
  // stay runnable there, which is why it is not environment-scoped.
  it("keeps 042 applicable in production while 039 has no receipt", () => {
    const { pending, notApplicable } = partitionPendingMigrations("compass_prod", new Set<string>())
    expect(pending.map((migration) => migration.name)).toContain(GATES_REPAIR)
    expect(notApplicable.map((entry) => entry.name)).not.toContain(GATES_REPAIR)
  })

  it("treats an applied migration as satisfying nothing on its own behalf", () => {
    expect(satisfyingAlternative(NATIVE_GATES, new Set([NATIVE_GATES, GATES_REPAIR]))).toBeNull()
    expect(satisfyingAlternative(GATES_REPAIR, new Set([NATIVE_GATES, GATES_REPAIR]))).toBeNull()
  })

  // ADR-0006 decided this exact output: a superseded 039 reports REPAIRED_BY and
  // is never relabeled APPLIED. Unchanged by the new symmetry.
  it("still reports a 042-superseded 039 as REPAIRED_BY, per ADR-0006", async () => {
    const health = await getDecisionGateInfrastructureHealth(healthClient(), "compass_prod", [GATES_REPAIR])
    expect(health.migrationReceipts).toContainEqual(expect.objectContaining({
      name: NATIVE_GATES,
      applied: false,
      status: "REPAIRED_BY",
      satisfiedBy: GATES_REPAIR,
      repairedBy: GATES_REPAIR,
    }))
  })

  it("reports a 039-retired 042 as satisfied by its alternative, not as a repair", async () => {
    const health = await getDecisionGateInfrastructureHealth(healthClient(), "compass_prod", [NATIVE_GATES])
    expect(health.migrationReceipts).toContainEqual(expect.objectContaining({
      name: GATES_REPAIR,
      applied: false,
      status: "SATISFIED_BY_ALTERNATIVE",
      satisfiedBy: NATIVE_GATES,
      // A clean 039 is not a repair of 042, so the repair vocabulary stays out.
      repairedBy: null,
    }))
  })
})

type ColumnRow = {
  table_name: string
  column_name: string
  data_type: string
  character_maximum_length: number | null
  datetime_precision: number | null
  is_nullable: string
  column_default: string | null
}

const catalog = getDecisionGateExpectedCatalog()

function expectedColumnRows(): ColumnRow[] {
  return catalog.columns.map((column) => ({
    table_name: column.table,
    column_name: column.name,
    data_type: column.type,
    character_maximum_length: column.maxLength,
    datetime_precision: column.datetimePrecision,
    is_nullable: column.nullable ? "YES" : "NO",
    column_default: column.default,
  }))
}

const ROADMAP_COLUMN_ROWS: ColumnRow[] = [
  { table_name: "roadmap_items", column_name: "now_commitment_provenance", data_type: "character varying", character_maximum_length: 30, datetime_precision: null, is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
  { table_name: "roadmap_items", column_name: "now_decision_record_id", data_type: "uuid", character_maximum_length: null, datetime_precision: null, is_nullable: "YES", column_default: null },
]

/**
 * A PoolClient standing in for a fully healthy decision-gate catalog: every
 * table, constraint and index present and matching, provenance and integrity
 * clean. `mutateColumns` lets one test perturb only the column shape, so a
 * shape-check assertion cannot accidentally pass because some unrelated part of
 * the health report went missing.
 */
function healthClient(mutateColumns: (rows: ColumnRow[]) => ColumnRow[] = (rows) => rows) {
  const columnRows = [...mutateColumns(expectedColumnRows()), ...ROADMAP_COLUMN_ROWS]
  return {
    query: async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      if (sql.includes("information_schema.tables")) {
        return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      }
      if (sql.includes("information_schema.columns")) {
        const tables = Array.isArray(values?.[1]) ? (values[1] as string[]) : []
        return { rows: columnRows.filter((row) => row.table_name === "roadmap_items" || tables.includes(row.table_name)) }
      }
      if (sql.includes("pg_get_indexdef")) {
        return { rows: catalog.indexes.map((index) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) }
      }
      if (sql.includes("FROM pg_constraint")) {
        return { rows: catalog.constraints.map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.definition, key_columns: constraint.keyColumns })) }
      }
      if (sql.includes("legacy_link_drift")) {
        return { rows: [{ total: "202", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      }
      if (sql.includes("plan_violations")) {
        return { rows: [{ plan_violations: "0", reservation_violations: "0" }] }
      }
      return { rows: [] }
    },
  } as unknown as PoolClient
}

const HEALTHY_RECEIPTS = [...catalog.migrations]

function reviewRequests(health: Awaited<ReturnType<typeof getDecisionGateInfrastructureHealth>>) {
  return health.tableShapes.find((shape) => shape.name === "review_requests")!
}

describe("decision-gate table shape check is expected-subset, not exact-equality", () => {
  // Production's real observed shape: 18 expected columns from 039-045, 22
  // actual, the four extras added by 051_decision_task_bridge. Before this
  // change that read as DRIFTED and pinned migrationReady to false forever.
  it("matches production's review_requests with four extra 051 columns, and computes migrationReady", async () => {
    const client = healthClient((rows) => [
      ...rows,
      ...BRIDGE_COLUMNS.map((column_name) => ({
        table_name: "review_requests",
        column_name,
        data_type: column_name === "no_action_at" ? "timestamp without time zone" : column_name === "no_action_reason" ? "text" : "uuid",
        character_maximum_length: null,
        datetime_precision: column_name === "no_action_at" ? 6 : null,
        is_nullable: "YES",
        column_default: null,
      })),
    ])

    const health = await getDecisionGateInfrastructureHealth(client, "compass_prod", HEALTHY_RECEIPTS)
    const shape = reviewRequests(health)

    expect(shape.expectedColumns).toHaveLength(18)
    expect(shape.actualColumns).toHaveLength(22)
    expect(shape.additionalColumns).toEqual([...BRIDGE_COLUMNS])
    expect(shape.missingColumns).toEqual([])
    expect(shape.mismatchedColumns).toEqual([])
    expect(shape.structureMatches).toBe(true)
    expect(shape.status).toBe("MATCHED_WITH_ADDITIONS")
    expect(health.migrationReady).toBe(true)
  })

  it("reports MATCHED with no additions when actual and expected are identical", async () => {
    const health = await getDecisionGateInfrastructureHealth(healthClient(), "compass_prod", HEALTHY_RECEIPTS)
    const shape = reviewRequests(health)

    expect(shape.status).toBe("MATCHED")
    expect(shape.additionalColumns).toEqual([])
    expect(health.migrationReady).toBe(true)
  })

  it("still fails when an expected column is missing", async () => {
    const client = healthClient((rows) => rows.filter((row) => !(row.table_name === "review_requests" && row.column_name === "gate_type")))

    const health = await getDecisionGateInfrastructureHealth(client, "compass_prod", HEALTHY_RECEIPTS)
    const shape = reviewRequests(health)

    expect(shape.missingColumns).toEqual(["gate_type"])
    expect(shape.structureMatches).toBe(false)
    expect(shape.status).toBe("DRIFTED")
    expect(health.migrationReady).toBe(false)
  })

  it("still fails when an expected column is missing even though extra columns are present", async () => {
    const client = healthClient((rows) => [
      ...rows.filter((row) => !(row.table_name === "review_requests" && row.column_name === "gate_type")),
      { table_name: "review_requests", column_name: "no_action_at", data_type: "timestamp without time zone", character_maximum_length: null, datetime_precision: 6, is_nullable: "YES", column_default: null },
    ])

    const health = await getDecisionGateInfrastructureHealth(client, "compass_prod", HEALTHY_RECEIPTS)
    const shape = reviewRequests(health)

    expect(shape.missingColumns).toEqual(["gate_type"])
    expect(shape.additionalColumns).toEqual(["no_action_at"])
    expect(shape.structureMatches).toBe(false)
    expect(health.migrationReady).toBe(false)
  })

  it.each([
    ["type", (row: ColumnRow) => ({ ...row, data_type: "text", character_maximum_length: null })],
    ["maxLength", (row: ColumnRow) => ({ ...row, character_maximum_length: 999 })],
    ["nullability", (row: ColumnRow) => ({ ...row, is_nullable: row.is_nullable === "YES" ? "NO" : "YES" })],
    ["default", (row: ColumnRow) => ({ ...row, column_default: "'SOMETHING_ELSE'::character varying" })],
  ])("still fails when an expected column's %s differs", async (_case, perturb) => {
    const client = healthClient((rows) => rows.map((row) => (row.table_name === "review_requests" && row.column_name === "gate_type" ? perturb(row) : row)))

    const health = await getDecisionGateInfrastructureHealth(client, "compass_prod", HEALTHY_RECEIPTS)
    const shape = reviewRequests(health)

    expect(shape.mismatchedColumns).toEqual(["gate_type"])
    expect(shape.missingColumns).toEqual([])
    expect(shape.structureMatches).toBe(false)
    expect(shape.status).toBe("DRIFTED")
    expect(health.migrationReady).toBe(false)
  })

  it("does not let an entirely absent table pass as a vacuous subset match", async () => {
    const client = healthClient((rows) => rows.filter((row) => row.table_name !== "release_run_tasks"))
    const health = await getDecisionGateInfrastructureHealth(client, "compass_prod", HEALTHY_RECEIPTS)

    // Every decision-gate table parses at least one expectation today, which is
    // what keeps the subset test meaningful — zero expectations would make any
    // actual shape pass, so the runner treats that as drift too.
    expect(health.tableShapes.every((shape) => shape.expectedColumns.length > 0)).toBe(true)
    const shape = health.tableShapes.find((item) => item.name === "release_run_tasks")!
    expect(shape.missingColumns).toHaveLength(shape.expectedColumns.length)
    expect(shape.structureMatches).toBe(false)
    expect(health.migrationReady).toBe(false)
  })
})

/**
 * A pool whose client answers the health/report queries as a healthy catalog and
 * reports `appliedNames` as finished receipts. Every statement is recorded so a
 * test can prove nothing was executed.
 */
function statusPool(appliedNames: readonly string[], mutateColumns?: (rows: ColumnRow[]) => ColumnRow[]) {
  const health = healthClient(mutateColumns) as unknown as { query: (sql: unknown, values?: unknown[]) => Promise<{ rows: unknown[] }> }
  const statements: string[] = []
  const client = {
    query: async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      statements.push(sql)
      if (sql.includes("migration_name as name")) return { rows: appliedNames.map((name) => ({ name, applied: true })) }
      if (sql.includes("SELECT migration_name FROM")) return { rows: appliedNames.map((migration_name) => ({ migration_name })) }
      if (sql.includes("information_schema.schemata")) return { rows: [{ schema_name: "compass_prod" }] }
      return health.query(sqlValue, values)
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client } as unknown as Pool, statements }
}

const NON_RECEIPT_DDL = /^\s*(CREATE|ALTER|DROP)\s/i

describe("GET migration status separates the manifest from applicable pending work", () => {
  it("reports production's two permanently-unapplicable entries as reasons, not as pending", async () => {
    const { pool } = statusPool([NATIVE_GATES])

    const body = await (await getMigrationStatus(pool, "compass_prod")).json()

    expect(body.schemaEnvironment).toBe("production")
    expect(body.pending).not.toContain(PREVIEW_AUTOMATION)
    expect(body.pending).not.toContain(GATES_REPAIR)
    expect(body.notApplicable).toEqual([
      { name: GATES_REPAIR, reason: `satisfied by ${NATIVE_GATES}` },
      { name: PREVIEW_AUTOMATION, reason: "scoped to development, preview" },
    ])
    // The manifest stays the complete registered list, unfiltered.
    expect(body.manifest).toContain(PREVIEW_AUTOMATION)
    expect(body.manifest).toContain(GATES_REPAIR)
    // Nothing is hidden: every registered name is applied, pending, or explained.
    const accounted = new Set([...body.appliedMigrations, ...body.pending, ...body.notApplicable.map((entry: { name: string }) => entry.name)])
    expect(body.manifest.filter((name: string) => !accounted.has(name))).toEqual([])
  })

  it("reports the whole unapplied manifest as pending when the schema name is unrecognized", async () => {
    const { pool } = statusPool([])

    const body = await (await getMigrationStatus(pool, "some_unregistered_schema")).json()

    expect(body.schemaEnvironment).toBeNull()
    expect(body.notApplicable).toEqual([])
    expect(body.pending).toEqual(body.manifest)
  })
})

describe("POST apply respects applicability", () => {
  it("refuses a targeted migration scoped to another environment without touching the database", async () => {
    const { pool, statements } = statusPool([])

    const response = await applyMigrations(pool, "compass_prod", PREVIEW_AUTOMATION)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toContain(PREVIEW_AUTOMATION)
    expect(body.error).toContain("not applicable")
    expect(body.error).toContain("scoped to development, preview")
    expect(body.error).toContain("Nothing was applied")
    expect(body.schemaEnvironment).toBe("production")
    expect(body.notApplicable).toEqual([{ name: PREVIEW_AUTOMATION, reason: "scoped to development, preview" }])
    // Never a success message, and never a receipt.
    expect(body).not.toHaveProperty("message")
    expect(statements.some((sql) => sql.includes("INSERT") && sql.includes("_prisma_migrations"))).toBe(false)
    expect(statements.some((sql) => sql.includes("preview_automation_sessions"))).toBe(false)
  })

  it("refuses a targeted migration already settled by its applied alternative", async () => {
    const { pool, statements } = statusPool([NATIVE_GATES])

    const response = await applyMigrations(pool, "compass_prod", GATES_REPAIR)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toContain(`satisfied by ${NATIVE_GATES}`)
    expect(body.notApplicable).toEqual([{ name: GATES_REPAIR, reason: `satisfied by ${NATIVE_GATES}` }])
    expect(statements.some((sql) => sql.includes("INSERT") && sql.includes("_prisma_migrations"))).toBe(false)
  })

  it("refuses the symmetric direction too: 039 when 042 is applied", async () => {
    const { pool } = statusPool([GATES_REPAIR])

    const response = await applyMigrations(pool, "compass_prod", NATIVE_GATES)
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toContain(`satisfied by ${GATES_REPAIR}`)
  })

  it("skips non-applicable migrations on a blanket apply instead of running them", async () => {
    // Everything applied except 047_preview_automation and 042 — both
    // non-applicable in production, so a blanket POST has nothing left to do.
    const manifest: string[] = (await (await getMigrationStatus(statusPool([]).pool, "compass_prod")).json()).manifest
    const applied = manifest.filter((name) => name !== PREVIEW_AUTOMATION && name !== GATES_REPAIR)
    const { pool, statements } = statusPool(applied)

    const response = await applyMigrations(pool, "compass_prod", undefined)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.message).toContain("Nothing to apply")
    expect(statements.some((sql) => sql.includes("preview_automation_sessions"))).toBe(false)
    expect(statements.filter((sql) => NON_RECEIPT_DDL.test(sql) && !sql.includes("_prisma_migrations") && !sql.includes("SCHEMA"))).toEqual([])
  })

  it("still applies a migration that is applicable in this environment", async () => {
    const { pool, statements } = statusPool([])

    // compass_preview is in 047_preview_automation's declared scope, so the
    // refusal must not fire and the DDL must actually run.
    const response = await applyMigrations(pool, "compass_preview", PREVIEW_AUTOMATION)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.not.toHaveProperty("error")
    expect(statements.some((sql) => sql.includes("preview_automation_sessions"))).toBe(true)
  })

  it("applies a scoped migration in an unrecognized schema, because scope resolution fails open", async () => {
    const { pool, statements } = statusPool([])

    const response = await applyMigrations(pool, "some_unregistered_schema", PREVIEW_AUTOMATION)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.not.toHaveProperty("error")
    expect(statements.some((sql) => sql.includes("preview_automation_sessions"))).toBe(true)
  })
})
