import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
  connect: vi.fn(),
  pool: vi.fn(),
}))

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor() {
      mocks.pool()
    }

    connect = mocks.connect
    end = mocks.end
  },
}))

vi.mock("@aws-sdk/dsql-signer", () => ({
  DsqlSigner: class MockDsqlSigner {
    getDbConnectAdminAuthToken = vi.fn().mockResolvedValue("token")
  },
}))

vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: vi.fn(),
}))

vi.mock("@/lib/schema", () => ({
  getActiveSchema: () => "compass_preview",
}))

import { GET, POST, getDecisionGateExpectedCatalog, normalizeConstraintDefinition } from "@/app/api/admin/migrate/route"
import { applyMigrations } from "@/lib/migrations/runner"

const ORIGINAL_ENV = { ...process.env }
const INDEX_NAMES = [
  "idx_research_participant_tokens_hash",
  "idx_research_participant_tokens_study_kind",
  "idx_research_sessions_resume_token",
  "idx_research_sessions_participant_token",
  "idx_research_requests_session_key",
  "idx_research_requests_session_created",
]
const GUIDED_INDEX_NAMES = [
  "idx_research_attachments_blob_pathname",
  "idx_research_attachments_session_key",
  "idx_research_attachments_session_created",
  "idx_research_attachments_turn_created",
  "idx_research_attachments_workspace_status",
  "idx_research_voice_events_session_provider",
  "idx_research_voice_events_session_created",
]
const RESEARCH_CLEANUP_INDEX_NAMES = [
  "idx_research_blob_cleanups_pathname",
  "idx_research_blob_cleanups_workspace_retry",
]
const LIVE_DSQL_ACTOR_CHECK = "CHECK (((actor_kind)::text = ANY ((ARRAY['USER'::character varying, 'SERVICE'::character varying])::text[])) AND (actor_id IS NOT NULL) OR ((actor_kind)::text = ANY ((ARRAY['ANONYMOUS'::character varying, 'SYSTEM'::character varying])::text[])) AND (actor_id IS NULL))"

function request(method: "GET" | "POST", body?: unknown, secret = "test-secret") {
  return new NextRequest("http://localhost/api/admin/migrate", {
    method,
    headers: {
      "content-type": "application/json",
      "x-migration-secret": secret,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function installQueryResponses({
  tokenRows = "8",
  tokenBytes = "4096",
  sequenceRows = "13",
  sequenceBytes = "8192",
  validIndexes = INDEX_NAMES,
  returnAsyncJobIds = false,
}: {
  tokenRows?: string
  tokenBytes?: string
  sequenceRows?: string
  sequenceBytes?: string
  validIndexes?: string[]
  returnAsyncJobIds?: boolean
} = {}) {
  mocks.query.mockImplementation(async (sqlValue: unknown) => {
    const sql = String(sqlValue)

    if (sql.includes("migration_name as name")) {
      return { rows: [{ name: "035_research_agent_scope" }] }
    }
    if (sql.includes("information_schema.tables")) {
      return { rows: [{ table_name: "research_studies" }, { table_name: "research_sessions" }] }
    }
    if (sql.includes("research_studies") && sql.includes("estimated_bytes")) {
      return { rows: [{ row_count: tokenRows, estimated_bytes: tokenBytes }] }
    }
    if (sql.includes("information_schema.columns")) {
      return { rows: [{ exists: false }] }
    }
    if (sql.includes("research_sessions") && sql.includes("estimated_bytes")) {
      return { rows: [{ row_count: sequenceRows, estimated_bytes: sequenceBytes }] }
    }
    if (sql.includes("pg_index") && sql.includes("indisvalid")) {
      return {
        rows: validIndexes.map((name) => ({ name, valid: true })),
      }
    }
    if (sql.includes("SELECT migration_name FROM")) {
      return { rows: [{ migration_name: "035_research_agent_scope" }] }
    }
    if (returnAsyncJobIds && /CREATE (?:UNIQUE )?INDEX ASYNC/i.test(sql)) {
      const indexName = sql.match(/INDEX ASYNC\s+(\S+)/i)?.[1] ?? "unknown"
      return { rows: [{ job_id: `job-${indexName}` }] }
    }
    if (sql.includes("sys.jobs")) {
      return {
        rows: [...INDEX_NAMES, ...GUIDED_INDEX_NAMES, ...RESEARCH_CLEANUP_INDEX_NAMES].map((name) => ({
          job_id: `job-${name}`,
          status: "submitted",
          details: null,
          object_name: `compass_preview.${name}`,
        })),
      }
    }
    return { rows: [] }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.MIGRATION_SECRET = "test-secret"
  process.env.DATABASE_URL = "postgresql://local/test"
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release })
  mocks.end.mockResolvedValue(undefined)
  installQueryResponses()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("/api/admin/migrate rollout observability", () => {
  it("does not create schemas in the pre-provisioned worker path", async () => {
    await applyMigrations({ connect: mocks.connect } as never, "compass_preview", undefined, { preProvisionedSchema: true })
    expect(mocks.query.mock.calls.some(([sql]) => /CREATE SCHEMA/i.test(sql))).toBe(false)
  })
  it("disables legacy admin migration access in automation previews", async () => {
    process.env.PREVIEW_AUTOMATION_ENABLED = "1"
    process.env.VERCEL_ENV = "preview"
    expect((await GET(request("GET"))).status).toBe(404)
    expect((await POST(request("POST"))).status).toBe(404)
    expect(mocks.pool).not.toHaveBeenCalled()
  })
  it("canonicalizes only the default UNIQUE NULLS DISTINCT rendering", () => {
    expect(normalizeConstraintDefinition('UNIQUE NULLS DISTINCT ("active_workspace_id")', "u")).toBe(normalizeConstraintDefinition('UNIQUE ("active_workspace_id")', "u"))
    expect(normalizeConstraintDefinition('UNIQUE NULLS NOT DISTINCT ("active_workspace_id")', "u")).not.toBe(normalizeConstraintDefinition('UNIQUE ("active_workspace_id")', "u"))
  })
  it("canonicalizes only Aurora DSQL literal-array ANY renderings as equivalent CHECK membership", () => {
    const expected = 'CHECK (("actor_kind" IN (\'USER\', \'SERVICE\') AND "actor_id" IS NOT NULL) OR ("actor_kind" IN (\'ANONYMOUS\', \'SYSTEM\') AND "actor_id" IS NULL))'
    expect(normalizeConstraintDefinition(LIVE_DSQL_ACTOR_CHECK, "c")).toBe(normalizeConstraintDefinition(expected, "c"))
    expect(normalizeConstraintDefinition(LIVE_DSQL_ACTOR_CHECK, "u")).not.toBe(normalizeConstraintDefinition(expected, "u"))
  })

  it.each([
    ["changed member", "CHECK ((actor_kind = ANY ((ARRAY['USER'::text, 'ROBOT'::text])::text[])) AND actor_id IS NOT NULL)"],
    ["changed left-hand column", "CHECK ((mode = ANY ((ARRAY['USER'::text, 'SERVICE'::text])::text[])) AND actor_id IS NOT NULL)"],
    ["ALL with a changed operator", "CHECK ((actor_kind <> ALL ((ARRAY['USER'::text, 'SERVICE'::text])::text[])) AND actor_id IS NOT NULL)"],
    ["runtime array", "CHECK ((actor_kind = ANY (allowed_actor_kinds)) AND actor_id IS NOT NULL)"],
    ["mixed literal array", "CHECK ((actor_kind = ANY ((ARRAY['USER'::text, current_user])::text[])) AND actor_id IS NOT NULL)"],
    ["NULL-bearing array", "CHECK ((actor_kind = ANY ((ARRAY['USER'::text, NULL])::text[])) AND actor_id IS NOT NULL)"],
    ["non-simple left-hand expression", "CHECK ((lower(actor_kind) = ANY ((ARRAY['USER'::text, 'SERVICE'::text])::text[])) AND actor_id IS NOT NULL)"],
  ])("does not canonicalize a %s as literal CHECK membership", (_case, actual) => {
    const membership = "CHECK ((actor_kind IN ('USER', 'SERVICE')) AND actor_id IS NOT NULL)"
    expect(normalizeConstraintDefinition(actual, "c")).not.toBe(normalizeConstraintDefinition(membership, "c"))
  })

  it("keeps actor nullability rules exact after DSQL membership canonicalization", () => {
    const expected = "CHECK ((actor_kind IN ('USER', 'SERVICE') AND actor_id IS NOT NULL))"
    const alteredNullRule = "CHECK (((actor_kind)::text = ANY ((ARRAY['USER'::text, 'SERVICE'::text])::text[])) AND actor_id IS NULL)"
    expect(normalizeConstraintDefinition(alteredNullRule, "c")).not.toBe(normalizeConstraintDefinition(expected, "c"))
  })
  it("does not expose migration preflight or index state without MIGRATION_SECRET", async () => {
    const response = await GET(request("GET", undefined, "wrong"))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" })
    expect(mocks.pool).not.toHaveBeenCalled()
  })

  it("fails closed when MIGRATION_SECRET is not configured", async () => {
    delete process.env.MIGRATION_SECRET

    const response = await GET(request("GET"))

    expect(response.status).toBe(401)
    expect(mocks.pool).not.toHaveBeenCalled()
  })
  it("reports violating capacity rows and cannot mark migrations ready", async () => {
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sql, values) => {
      if (String(sql).includes("plan_violations")) return { rows: [{ plan_violations: "1", reservation_violations: "2" }] }
      return fallback(sql, values)
    })
    const result = await (await GET(request("GET"))).json()
    expect(result.decisionGateInfrastructure.integrity).toEqual({ available: true, planViolations: 1, reservationViolations: 2 })
    expect(result.decisionGateInfrastructure.migrationReady).toBe(false)
  })
  it("rejects same-name constraints and indexes with the wrong table or definition", async () => {
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sql, values) => {
      const text = String(sql)
      if (text.includes("FROM pg_constraint")) return { rows: [{ constraint_name: "portfolio_capacity_plans_pkey", table_name: "wrong_table", constraint_type: "p", valid: true, definition: "PRIMARY KEY (wrong_id)" }] }
      if (text.includes("pg_get_indexdef")) return { rows: [{ name: "idx_capacity_plans_workspace_state", table_name: "wrong_table", valid: true, definition: "CREATE INDEX idx_capacity_plans_workspace_state ON wrong_table (wrong_id)" }] }
      return fallback(sql, values)
    })
    const result = (await (await GET(request("GET"))).json()).decisionGateInfrastructure
    expect(result.constraints).toContainEqual(expect.objectContaining({ name: "portfolio_capacity_plans_pkey", present: true, structureMatches: false }))
    expect(result.indexes).toContainEqual(expect.objectContaining({ name: "idx_capacity_plans_workspace_state", present: true, structureMatches: false, state: "FAILED_OR_MISMATCHED" }))
    expect(result.migrationReady).toBe(false)
  })
  it("marks the complete migration-derived catalog ready including multi-column UNIQUE and both CHECK constraints", async () => {
    const catalog = getDecisionGateExpectedCatalog()
    expect(catalog.columns.filter((column) => column.table === "release_runs")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "head_sha", type: "character", maxLength: 40, nullable: false, default: null }),
      expect.objectContaining({ name: "provider", type: "character varying", maxLength: 30, nullable: false, default: "GITHUB" }),
    ]))
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sqlValue, values) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: catalog.migrations.map((name) => ({ name })) }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        ...catalog.columns.map((column, index) => ({ table_name: column.table, column_name: column.name, data_type: column.type, character_maximum_length: column.maxLength, datetime_precision: column.datetimePrecision, is_nullable: column.nullable ? "YES" : "NO", column_default: column.default === "0" ? (index % 2 ? "0::integer" : "'0'::integer") : column.default })),
        { table_name: "roadmap_items", column_name: "now_commitment_provenance", data_type: "character varying", character_maximum_length: 30, datetime_precision: null, is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        { table_name: "roadmap_items", column_name: "now_decision_record_id", data_type: "uuid", character_maximum_length: null, datetime_precision: null, is_nullable: "YES", column_default: null },
      ] }
      if (sql.includes("pg_get_indexdef")) return { rows: catalog.indexes.map((index, indexNumber) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: indexNumber === 0 ? `CREATE INDEX ${index.name} ON compass_preview.${index.table} USING btree_index ("workspace_id", "state")` : index.definition })) }
      if (sql.includes("FROM pg_constraint")) return { rows: catalog.constraints.map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.name === "chk_now_gate_evaluations_actor" ? LIVE_DSQL_ACTOR_CHECK : ["idx_capacity_plans_active_workspace", "idx_capacity_reservations_active_item"].includes(constraint.name) ? constraint.definition.replace("unique nulls distinct", "UNIQUE") : constraint.definition, key_columns: constraint.keyColumns })) }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "4", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [{ plan_violations: "0", reservation_violations: "0" }] }
      return fallback(sqlValue, values)
    })
    const result = (await (await GET(request("GET"))).json()).decisionGateInfrastructure
    expect(catalog.constraints.find((item) => item.name === "idx_release_runs_scope_fingerprint")?.definition).toContain("pull_request_number")
    expect(result.constraints.filter((item: { type: string }) => item.type === "c")).toHaveLength(6)
    expect(result.tableShapes.filter((item: { structureMatches: boolean }) => !item.structureMatches)).toEqual([])
    expect(result.tableShapes.find((item: { name: string }) => item.name === "review_requests")).toMatchObject({
      status: "MATCHED",
      expectedColumns: expect.arrayContaining([expect.objectContaining({ name: "revision_count", default: "0" })]),
      actualColumns: expect.arrayContaining([expect.objectContaining({ name: "revision_count", default: "0" })]),
    })
    expect(result.constraints.find((item: { name: string }) => item.name === "review_requests_pkey")).toMatchObject({ status: "MATCHED", expectedKeyColumns: ["id"], actualKeyColumns: ["id"] })
    expect(result.constraints.find((item: { name: string }) => item.name === "idx_capacity_plans_active_workspace")).toMatchObject({ status: "MATCHED", structureMatches: true })
    expect(result.constraints.find((item: { name: string }) => item.name === "chk_now_gate_evaluations_actor")).toMatchObject({ status: "MATCHED", structureMatches: true })
    expect(result.indexes.find((item: { name: string }) => item.name === "idx_review_requests_workspace_state")).toMatchObject({ status: "MATCHED", expectedKeyColumns: ["workspace_id", "state"], actualKeyColumns: ["workspace_id", "state"] })
    expect(result.migrationReady).toBe(true)
    const constraintQuery = mocks.query.mock.calls.find(([sql]) => String(sql).includes("FROM pg_constraint"))
    expect(String(constraintQuery?.[0])).toContain("backing.indexrelid=c.conindid")
    expect(String(constraintQuery?.[0])).toContain("key.ordinal <= backing.indnkeyatts")
    expect(String(constraintQuery?.[0])).toContain("a.attname::text")
    expect(String(constraintQuery?.[0])).toContain("ARRAY[]::text[]")
    const indexQuery = mocks.query.mock.calls.find(([sql]) => String(sql).includes("pg_get_indexdef"))
    expect(String(indexQuery?.[0])).toContain("a.attname::text")
    expect(String(indexQuery?.[0])).toContain("ARRAY[]::text[]")
  })

  it("rejects a same-name table whose complete column fingerprint is malformed", async () => {
    const catalog = getDecisionGateExpectedCatalog()
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sqlValue, values) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: catalog.migrations.map((name) => ({ name })) }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) {
        return { rows: catalog.columns.map((column) => ({
          table_name: column.table,
          column_name: column.name,
          data_type: column.name === "head_sha" ? "text" : column.type,
          character_maximum_length: column.maxLength,
          datetime_precision: column.datetimePrecision,
          is_nullable: column.nullable ? "YES" : "NO",
          column_default: column.default,
        })) }
      }
      if (sql.includes("pg_get_indexdef")) return { rows: catalog.indexes.map((index) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) }
      if (sql.includes("FROM pg_constraint")) return { rows: catalog.constraints.map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.definition, key_columns: constraint.keyColumns })) }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "0", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [{ plan_violations: "0", reservation_violations: "0" }] }
      return fallback(sqlValue, values)
    })

    const result = (await (await GET(request("GET"))).json()).decisionGateInfrastructure
    expect(result.tableShapes).toContainEqual(expect.objectContaining({ name: "release_runs", structureMatches: false }))
    expect(result.migrationReady).toBe(false)
  })

  it("accepts Aurora DSQL primary-key INCLUDE rendering without weakening other constraint comparisons", async () => {
    const catalog = getDecisionGateExpectedCatalog()
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sqlValue, values) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: catalog.migrations.map((name) => ({ name })) }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        ...catalog.columns.map((column) => ({ table_name: column.table, column_name: column.name, data_type: column.type, character_maximum_length: column.maxLength, datetime_precision: column.datetimePrecision, is_nullable: column.nullable ? "YES" : "NO", column_default: column.default })),
        { table_name: "roadmap_items", column_name: "now_commitment_provenance", data_type: "character varying", character_maximum_length: 30, datetime_precision: null, is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        { table_name: "roadmap_items", column_name: "now_decision_record_id", data_type: "uuid", character_maximum_length: null, datetime_precision: null, is_nullable: "YES", column_default: null },
      ] }
      if (sql.includes("pg_get_indexdef")) return { rows: catalog.indexes.map((index) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) }
      if (sql.includes("FROM pg_constraint")) return { rows: catalog.constraints.map((constraint) => ({
        constraint_name: constraint.name,
        table_name: constraint.table,
        constraint_type: constraint.type,
        valid: true,
        key_columns: constraint.keyColumns,
        definition: constraint.type === "p" ? `${constraint.definition} INCLUDE (workspace_id)` : constraint.definition,
      })) }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "4", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [{ plan_violations: "0", reservation_violations: "0" }] }
      return fallback(sqlValue, values)
    })

    const result = (await (await GET(request("GET"))).json()).decisionGateInfrastructure
    expect(result.constraints.filter((item: { type: string; structureMatches: boolean }) => item.type === "p" && !item.structureMatches)).toEqual([])
    expect(result.tableShapes.filter((item: { structureMatches: boolean }) => !item.structureMatches)).toEqual([])
    expect(result.migrationReady).toBe(true)
  })

  it("reports partially applied 039 as not ready until the repair receipt and missing structures exist", async () => {
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sqlValue, values) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: [{ name: "039_native_decision_gates", applied: false }] }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: values[1].slice(0, 5).map((table_name: string) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        { column_name: "now_commitment_provenance", is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
      ] }
      return fallback(sqlValue, values)
    })
    const result = (await (await GET(request("GET"))).json()).decisionGateInfrastructure
    expect(result.migrationReceipts).toContainEqual(expect.objectContaining({ name: "039_native_decision_gates", applied: false, status: "INCOMPLETE" }))
    expect(result.migrationReceipts).toContainEqual(expect.objectContaining({ name: "042_native_decision_gates_repair", applied: false }))
    expect(result.columns).toContainEqual(expect.objectContaining({ name: "now_decision_record_id", present: false }))
    expect(result.migrationReady).toBe(false)
  })

  it("keeps the existing GET fields and adds passing migration 036 preflight details", async () => {
    const response = await GET(request("GET"))

    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      schema: "compass_preview",
      appliedMigrations: ["035_research_agent_scope"],
      manifest: expect.arrayContaining(["036_research_capture_hardening"]),
      researchCaptureHardening: {
        preflight: {
          limits: { maxRows: 3_000, maxBytes: 10 * 1024 * 1024 },
          tokenBackfill: {
            rowCount: 8,
            estimatedBytes: 4096,
            estimateBasis: "conservative full source-row bytes",
            passed: true,
          },
          nextSequenceBackfill: {
            rowCount: 13,
            estimatedBytes: 8192,
            estimateBasis: "conservative full source-row bytes",
            passed: true,
          },
          passed: true,
        },
        indexesValid: true,
      },
    })
    expect(result.manifest).toContain("037_research_guided_ux")
    expect(result.manifest).toContain("038_research_blob_cleanup")
    expect(result.researchGuidedUx).toMatchObject({
      preflight: { passed: true, writesExistingRows: false },
      indexesValid: false,
    })
    expect(result.researchBlobCleanup).toMatchObject({
      preflight: { passed: true, writesExistingRows: false },
      indexesValid: false,
    })
    expect(result.manifest).toEqual(expect.arrayContaining([
      "039_native_decision_gates",
      "040_release_authorization",
      "041_portfolio_capacity_ledger",
    ]))
    expect(result.decisionGateInfrastructure).toMatchObject({
      migrationReady: false,
      capacityMetadataReady: false,
      runtimeEnforcementReady: false,
      integrity: { available: false, planViolations: Number.MAX_SAFE_INTEGER, reservationViolations: Number.MAX_SAFE_INTEGER },
      tables: expect.arrayContaining([expect.objectContaining({ name: "review_requests", present: false })]),
      columns: expect.arrayContaining([expect.objectContaining({ name: "now_commitment_provenance", present: false })]),
      indexes: expect.arrayContaining([expect.objectContaining({ name: "idx_capacity_plans_workspace_state", present: false, valid: false })]),
    })
  })

  it("reports every required index and marks missing or invalid indexes false", async () => {
    installQueryResponses({ validIndexes: INDEX_NAMES.slice(0, 4) })

    const response = await GET(request("GET"))
    const result = await response.json()

    expect(result.researchCaptureHardening.indexes).toEqual(
      INDEX_NAMES.map((name, index) => ({
        name,
        present: index < 4,
        valid: index < 4,
      }))
    )
    expect(result.researchCaptureHardening.indexesValid).toBe(false)
    const indexQuery = mocks.query.mock.calls.find(([sql]) => String(sql).includes("pg_index"))
    expect(String(indexQuery?.[0])).toContain("indisvalid")
    expect(String(indexQuery?.[0])).toContain("pg_class")
  })

  it("reports unavailable preflight sources instead of failing GET before research migrations exist", async () => {
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: [] }
      if (sql.includes("information_schema.tables")) return { rows: [] }
      if (sql.includes("pg_index")) return { rows: [] }
      return { rows: [] }
    })

    const response = await GET(request("GET"))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.researchCaptureHardening).toMatchObject({
      preflight: {
        tokenBackfill: { available: false, passed: false },
        nextSequenceBackfill: { available: false, passed: false },
        passed: false,
      },
      indexesValid: false,
    })
  })

  it("fails preflight at more than 3,000 rows or 10 MiB", async () => {
    installQueryResponses({ tokenRows: "3001", sequenceBytes: String(10 * 1024 * 1024 + 1) })

    const response = await GET(request("GET"))
    const result = await response.json()

    expect(result.researchCaptureHardening.preflight).toMatchObject({
      tokenBackfill: { passed: false },
      nextSequenceBackfill: { passed: false },
      passed: false,
    })
  })

  it("allows exact DSQL write-limit boundaries", async () => {
    installQueryResponses({
      tokenRows: "3000",
      tokenBytes: String(10 * 1024 * 1024),
      sequenceRows: "3000",
      sequenceBytes: String(10 * 1024 * 1024),
    })

    const response = await GET(request("GET"))
    const result = await response.json()

    expect(result.researchCaptureHardening.preflight.passed).toBe(true)
  })

  it("refuses migration 036 before writing when its preflight exceeds DSQL limits", async () => {
    installQueryResponses({ tokenRows: "3001" })

    const response = await POST(request("POST", { script: "036_research_capture_hardening" }))

    expect(response.status).toBe(409)
    const result = await response.json()
    expect(result).toMatchObject({
      error: expect.stringContaining("preflight"),
      researchCaptureHardening: { preflight: { passed: false } },
    })
    expect(
      mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO") && String(sql).includes("_prisma_migrations"))
    ).toBe(false)
  })

  it("leaves failed DDL as an unfinished forensic attempt, never a successful receipt", async () => {
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (/CREATE TABLE IF NOT EXISTS "review_requests"/.test(sql)) throw new Error("unsupported DDL")
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: "039_native_decision_gates" }))

    expect(response.status).toBe(500)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO "compass_preview"._prisma_migrations'))).toBe(true)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "compass_preview"._prisma_migrations SET finished_at'))).toBe(false)
  })

  it("rejects a concurrently claimed decision migration without launching DDL or finishing a receipt", async () => {
    delete process.env.DATABASE_URL
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "039_native_decision_gates")!
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: 0, pending_job_id: null, pending_step: null }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [], rowCount: 0 }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: "039_native_decision_gates" }))

    expect(response.status).toBe(409)
    expect(mocks.query.mock.calls.some(([sql]) => /CREATE TABLE IF NOT EXISTS "review_requests"/.test(String(sql)))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET finished_at"))).toBe(false)
  })

  it("fences an owner whose lease expires before async DDL launch", async () => {
    delete process.env.DATABASE_URL
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "040_release_authorization")!
    const asyncStep = plan.steps.findIndex((step) => step.async)
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: asyncStep, pending_job_id: null, pending_step: null, executing_step: null, claim_epoch: 1 }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 2 }], rowCount: 1 }
      if (sql.includes("SET executing_step=$4")) return { rows: [], rowCount: 0 }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(500)
    expect(mocks.query.mock.calls.some(([sql]) => /CREATE INDEX ASYNC/.test(String(sql)))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET finished_at"))).toBe(false)
  })

  it("recovers a stale pre-launch EXECUTING intent only after proving no DSQL job exists", async () => {
    delete process.env.DATABASE_URL
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "040_release_authorization")!
    const asyncStep = plan.steps.findIndex((step) => step.async)
    let launches = 0
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: asyncStep, pending_job_id: null, pending_step: null, executing_step: asyncStep, executing_started_at: "2020-01-01T00:00:00Z", claim_epoch: 1 }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 2 }], rowCount: 1 }
      if (sql.includes("FROM sys.jobs") && sql.includes("object_name=$1")) return { rows: [] }
      if (sql.includes("SET executing_step=NULL")) return { rows: [], rowCount: 1 }
      if (sql.includes("SET executing_step=$4")) return { rows: [], rowCount: 1 }
      if (/CREATE INDEX ASYNC/.test(sql)) { launches += 1; return { rows: [{ job_id: "job-recovered" }] } }
      if (sql.includes("SET pending_step=$4")) return { rows: [], rowCount: 1 }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(202)
    expect(launches).toBe(1)
  })

  it("does not advance a synchronous step after its fenced lease ownership is lost", async () => {
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "040_release_authorization")!
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: 0, pending_job_id: null, pending_step: null, executing_step: null, executing_started_at: null, claim_epoch: 1 }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 2 }], rowCount: 1 }
      if (sql.includes("SET executing_step=$4")) return { rows: [], rowCount: 1 }
      if (sql.includes("SET next_step=next_step+1")) return { rows: [], rowCount: 0 }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(500)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET finished_at"))).toBe(false)
  })

  it("reconciles a lost ADD CHECK NOT VALID response without requiring validation or relaunching", async () => {
    delete process.env.DATABASE_URL
    const catalog = getDecisionGateExpectedCatalog()
    const plan = catalog.plans.find((item) => item.name === "039_native_decision_gates")!
    const addCheckStep = plan.steps.findIndex((step) => step.sql?.includes('ADD CONSTRAINT "chk_roadmap_items_commitment_provenance_not_null"'))
    const constraint = catalog.constraints.find((item) => item.name === "chk_roadmap_items_commitment_provenance_not_null")!
    let relaunches = 0
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: addCheckStep, pending_job_id: null, pending_step: null, executing_step: addCheckStep, executing_started_at: new Date().toISOString(), claim_epoch: 1 }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 2 }], rowCount: 1 }
      if (sql.includes("FROM pg_constraint")) return { rows: [{ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: false, definition: "CHECK ((now_commitment_provenance IS NOT NULL)) NOT VALID", key_columns: constraint.keyColumns }] }
      if (sql.includes("SET next_step=next_step+1, executing_step=NULL")) return { rows: [], rowCount: 1 }
      if (sql.includes('ADD CONSTRAINT "chk_roadmap_items_commitment_provenance_not_null"')) { relaunches += 1; return { rows: [] } }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(202)
    expect((await response.json()).migrationProgress).toMatchObject({ state: "ADVANCED", nextStep: addCheckStep + 1 })
    expect(relaunches).toBe(0)
  })

  it("rejects malformed existing 039 table columns before migration 042 mutates anything", async () => {
    const catalog = getDecisionGateExpectedCatalog()
    const repairTables = catalog.tables.slice(0, 5)
    mocks.query.mockImplementation(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [{ migration_name: "039_native_decision_gates" }] }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: repairTables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        { table_name: "roadmap_items", column_name: "now_commitment_provenance", data_type: "character varying", character_maximum_length: 30, datetime_precision: null, is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        { table_name: "roadmap_items", column_name: "now_decision_record_id", data_type: "uuid", character_maximum_length: null, datetime_precision: null, is_nullable: "YES", column_default: null },
      ] }
      if (sql.includes("information_schema.columns") && sql.includes("table_name=ANY")) return { rows: [{ table_name: "review_requests", column_name: "id", data_type: "text", character_maximum_length: null, datetime_precision: null, is_nullable: "NO", column_default: null }] }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "0", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: "042_native_decision_gates_repair" }))
    expect(response.status).toBe(500)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO") && String(sql).includes("_migration_execution_state"))).toBe(false)
    expect(mocks.query.mock.calls.some(([sql]) => /ALTER TABLE ASYNC|CREATE INDEX ASYNC/.test(String(sql)))).toBe(false)
  })

  it("fails closed when an async DDL launch returns no job_id", async () => {
    delete process.env.DATABASE_URL
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "040_release_authorization")!
    const asyncStep = plan.steps.findIndex((step) => step.async)
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: asyncStep, pending_job_id: null, pending_step: null }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 1 }], rowCount: 1 }
      if (sql.includes("SET claim_expires_at=CURRENT_TIMESTAMP")) return { rows: [{ migration_name: "042_native_decision_gates_repair" }], rowCount: 1 }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(500)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET finished_at"))).toBe(false)
  })

  it.each([
    { status: "submitted", expectedStatus: 202 },
    { status: "processing", expectedStatus: 202 },
    { status: "failed", expectedStatus: 500 },
    { status: null, expectedStatus: 500 },
  ])("keeps a $status async job from earning a finished receipt", async ({ status, expectedStatus }) => {
    delete process.env.DATABASE_URL
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "040_release_authorization")!
    const asyncStep = plan.steps.findIndex((step) => step.async)
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: asyncStep, pending_job_id: "job-1", pending_step: asyncStep }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 1 }], rowCount: 1 }
      if (sql.includes("FROM sys.jobs") && sql.includes("job_id=$1")) return { rows: status ? [{ status, details: status === "failed" ? "boom" : null }] : [] }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(expectedStatus)
    if (status === "processing") {
      await expect(response.json()).resolves.toMatchObject({ migrationProgress: { state: "WAITING", jobId: "job-1" } })
    }
    if (status === "failed") {
      await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("failed: boom") })
    }
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET finished_at"))).toBe(false)
  })

  it("does not finish the durable receipt when exact catalog postconditions fail", async () => {
    delete process.env.DATABASE_URL
    const plan = getDecisionGateExpectedCatalog().plans.find((item) => item.name === "040_release_authorization")!
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: "attempt-1", plan_fingerprint: plan.fingerprint, next_step: plan.steps.length, pending_job_id: null, pending_step: null }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 1 }], rowCount: 1 }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(500)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET finished_at"))).toBe(false)
  })

  it.each([
    { actorDefinition: LIVE_DSQL_ACTOR_CHECK, expectedStatus: 200, expectedState: "COMPLETE" },
    { actorDefinition: LIVE_DSQL_ACTOR_CHECK.replace("'SERVICE'", "'ROBOT'"), expectedStatus: 500, expectedState: undefined },
  ])("validates the exact catalog before terminal migration 045 receipt completion", async ({ actorDefinition, expectedStatus, expectedState }) => {
    delete process.env.DATABASE_URL
    const catalog = getDecisionGateExpectedCatalog()
    const plan = catalog.plans.find((item) => item.name === "045_now_gate_shadow_evaluations")!
    const attemptId = "00000000-0000-4000-8000-000000000045"
    const appliedBefore045 = catalog.migrations.filter((name) => name !== plan.name)

    mocks.query.mockImplementation(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM") && sql.includes("finished_at IS NOT NULL")) return { rows: appliedBefore045.map((migration_name) => ({ migration_name })) }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) return { rows: [{ attempt_id: attemptId, plan_fingerprint: plan.fingerprint, next_step: plan.steps.length, pending_job_id: null, pending_step: null, executing_step: null, executing_started_at: null, claim_epoch: 3 }] }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 4 }], rowCount: 1 }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("table_name=ANY")) return { rows: catalog.columns.filter((column) => column.table === "now_gate_evaluations").map((column) => ({ table_name: column.table, column_name: column.name, data_type: column.type, character_maximum_length: column.maxLength, datetime_precision: column.datetimePrecision, is_nullable: column.nullable ? "YES" : "NO", column_default: column.default })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        ...catalog.columns.map((column) => ({ table_name: column.table, column_name: column.name, data_type: column.type, character_maximum_length: column.maxLength, datetime_precision: column.datetimePrecision, is_nullable: column.nullable ? "YES" : "NO", column_default: column.default })),
        { table_name: "roadmap_items", column_name: "now_commitment_provenance", data_type: "character varying", character_maximum_length: 30, datetime_precision: null, is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        { table_name: "roadmap_items", column_name: "now_decision_record_id", data_type: "uuid", character_maximum_length: null, datetime_precision: null, is_nullable: "YES", column_default: null },
      ] }
      if (sql.includes("pg_get_indexdef")) return { rows: catalog.indexes.map((index) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) }
      if (sql.includes("FROM pg_constraint")) return { rows: catalog.constraints.map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.name === "chk_now_gate_evaluations_actor" ? actorDefinition : constraint.definition, key_columns: constraint.keyColumns })) }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "0", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [{ plan_violations: "0", reservation_violations: "0" }] }
      if (sql.includes("SET claim_expires_at=CURRENT_TIMESTAMP")) return { rows: [{ migration_name: plan.name }], rowCount: 1 }
      if (sql.includes("SET finished_at=CURRENT_TIMESTAMP")) return { rows: [{ id: attemptId }], rowCount: 1 }
      if (sql.includes("DELETE FROM") && sql.includes("_migration_execution_state")) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })

    const response = await POST(request("POST", { script: plan.name }))
    expect(response.status).toBe(expectedStatus)
    if (expectedState) await expect(response.json()).resolves.toMatchObject({ migrationProgress: { state: expectedState, attemptId, nextStep: plan.steps.length } })
    const calls = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(calls.some((sql) => /(?:CREATE|ALTER).*(?:now_gate_evaluations|idx_now_gate_evaluations)/i.test(sql))).toBe(false)
    expect(calls.some((sql) => sql.includes("SET finished_at=CURRENT_TIMESTAMP"))).toBe(expectedStatus === 200)
    expect(calls.some((sql) => sql.includes("DELETE FROM") && sql.includes("_migration_execution_state"))).toBe(expectedStatus === 200)
  })

  it("reconciles a lost async-job persistence response without relaunching DDL, then finishes", async () => {
    delete process.env.DATABASE_URL
    const catalog = getDecisionGateExpectedCatalog()
    const repairTables: string[] = catalog.tables.slice(0, 5)
    const repairIndexes = catalog.indexes.filter((index) => index.name.startsWith("idx_review_") || index.name.startsWith("idx_decision_"))
    const repairConstraints = catalog.constraints.filter((constraint) =>
      repairTables.includes(constraint.table) || constraint.name === "chk_roadmap_items_commitment_provenance_not_null"
    )
    let job = 0
    let sawPendingInvalidIndexResume = false
    let searchPathSet = false
    let loseFirstJobPersistence = true
    let run: { attempt_id: string; plan_fingerprint: string; next_step: number; pending_job_id: string | null; pending_step: number | null; executing_step: number | null } | undefined
    mocks.query.mockImplementation(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      if (sql === 'SET search_path TO "compass_preview"') { searchPathSet = true; return { rows: [] } }
      if (sql.includes("SELECT migration_name FROM")) return { rows: [{ migration_name: "039_native_decision_gates" }] }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: repairTables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        ...catalog.columns.filter((column) => repairTables.includes(column.table)).map((column) => ({ table_name: column.table, column_name: column.name, data_type: column.type, character_maximum_length: column.maxLength, datetime_precision: column.datetimePrecision, is_nullable: column.nullable ? "YES" : "NO", column_default: column.default })),
        { table_name: "roadmap_items", column_name: "now_commitment_provenance", data_type: "character varying", character_maximum_length: 30, datetime_precision: null, is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        { table_name: "roadmap_items", column_name: "now_decision_record_id", data_type: "uuid", character_maximum_length: null, datetime_precision: null, is_nullable: "YES", column_default: null },
      ] }
      if (sql.includes("information_schema.columns") && sql.includes("table_name=ANY")) return { rows: catalog.columns.filter((column) => repairTables.includes(column.table) && column.name !== "source_fingerprint").map((column) => ({ table_name: column.table, column_name: column.name, data_type: column.type, character_maximum_length: column.maxLength, datetime_precision: column.datetimePrecision, is_nullable: column.nullable ? "YES" : "NO", column_default: column.default })) }
      if (sql.includes("FROM pg_constraint")) return { rows: repairConstraints.map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.definition, key_columns: constraint.keyColumns })) }
      if (sql.includes("pg_get_indexdef")) return { rows: repairIndexes.slice(0, job).map((index, indexNumber) => ({ name: index.name, table_name: index.table, valid: !(run?.pending_job_id && indexNumber === job - 1), unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "4", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [] }
      if (sql.includes("pg_column_size")) return { rows: [] }
      if (sql.includes("SELECT attempt_id") && sql.includes("_migration_execution_state")) {
        if (run?.pending_job_id) sawPendingInvalidIndexResume = true
        return { rows: run ? [run] : [] }
      }
      if (sql.includes("INSERT INTO") && sql.includes("_migration_execution_state")) {
        run = { attempt_id: String(values?.[1]), plan_fingerprint: String(values?.[3]), next_step: 0, pending_job_id: null, pending_step: null, executing_step: null }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET claimed_by=$2")) return { rows: [{ claim_epoch: 1 }], rowCount: 1 }
      if (sql.includes("SET pending_step=$4")) {
        if (loseFirstJobPersistence) { loseFirstJobPersistence = false; throw new Error("injected lost response after DDL launch") }
        run!.pending_step = Number(values?.[3]); run!.pending_job_id = String(values?.[4]); run!.executing_step = null; return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET next_step=next_step+1, executing_step=NULL")) { run!.next_step += 1; run!.executing_step = null; return { rows: [], rowCount: 1 } }
      if (sql.includes("SET next_step=next_step+1")) {
        run!.next_step += 1
        if (sql.includes("pending_step=NULL")) { run!.pending_step = null; run!.pending_job_id = null }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("SET executing_step=$4")) { run!.executing_step = Number(values?.[3]); return { rows: [], rowCount: 1 } }
      if (/^(?:ALTER TABLE|CREATE INDEX)/i.test(sql) && !sql.includes("_migration_execution_state") && !searchPathSet) throw new Error("relation \"roadmap_items\" does not exist")
      if (/ALTER TABLE ASYNC|CREATE INDEX ASYNC/i.test(sql)) return { rows: [{ job_id: `repair-job-${++job}` }] }
      if (sql.includes("FROM sys.jobs") && sql.includes("job_id=$1")) return { rows: [{ status: "completed", details: null }] }
      if (sql.includes("DELETE FROM") && sql.includes("_migration_execution_state")) { run = undefined; return { rows: [], rowCount: 1 } }
      if (sql.includes("SET claim_expires_at=CURRENT_TIMESTAMP")) return { rows: [{ migration_name: "042_native_decision_gates_repair" }], rowCount: 1 }
      if (sql.includes("SET finished_at=CURRENT_TIMESTAMP")) return { rows: [{ id: run?.attempt_id }], rowCount: 1 }
      return { rows: [] }
    })

    let response: Response | undefined
    let injectedFailures = 0
    for (let invocation = 0; invocation < 40; invocation += 1) {
      response = await POST(request("POST", { script: "042_native_decision_gates_repair" }))
      if (response.status === 200) break
      if (response.status === 500) { injectedFailures += 1; continue }
      expect(response.status).toBe(202)
      expect(mocks.query.mock.calls.filter(([sql]) => /ALTER TABLE ASYNC|CREATE INDEX ASYNC/i.test(String(sql))).length).toBeLessThanOrEqual(invocation + 1)
    }

    expect(response?.status).toBe(200)
    expect(sawPendingInvalidIndexResume).toBe(true)
    expect(searchPathSet).toBe(true)
    expect(injectedFailures).toBe(1)
    expect(job).toBe(7)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("FROM sys.jobs") && String(sql).includes("job_id=$1"))).toHaveLength(6)
    const calls = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(calls.findIndex((sql) => sql.includes("SET finished_at"))).toBeGreaterThan(calls.map((sql, index) => sql.includes("FROM sys.jobs") ? index : -1).at(-1)!)
  })

  it("no-ops an explicit migration that already has a finished receipt", async () => {
    mocks.query.mockImplementation(async (sqlValue: unknown) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) {
        return { rows: [{ migration_name: "036_research_capture_hardening" }] }
      }
      if (sql.includes("information_schema.tables")) {
        return { rows: [{ table_name: "research_studies" }, { table_name: "research_sessions" }] }
      }
      if (sql.includes("research_studies") && sql.includes("estimated_bytes")) {
        return { rows: [{ row_count: "0", estimated_bytes: "0" }] }
      }
      if (sql.includes("information_schema.columns")) return { rows: [{ exists: true }] }
      if (sql.includes("research_sessions") && sql.includes("estimated_bytes")) {
        return { rows: [{ row_count: "0", estimated_bytes: "0" }] }
      }
      if (sql.includes("pg_index")) {
        return { rows: INDEX_NAMES.map((name) => ({ name, valid: true })) }
      }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: "036_research_capture_hardening" }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      message: "Nothing to apply. All migrations up to date.",
      researchCaptureHardening: { indexesValid: true },
    })
  })

  it("surfaces DSQL async index job IDs and status without blocking the 60-second route", async () => {
    delete process.env.DATABASE_URL
    installQueryResponses({ returnAsyncJobIds: true })

    const response = await POST(request("POST", { script: "036_research_capture_hardening" }))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.researchCaptureHardening.asyncIndexJobs).toMatchObject({
      waited: false,
      jobIds: INDEX_NAMES.map((name) => `job-${name}`),
      jobs: INDEX_NAMES.map((name) => ({ jobId: `job-${name}`, status: "submitted" })),
      reason: expect.stringContaining("60-second"),
    })
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("sys.jobs"))).toBe(true)
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("sys.wait_for_job"))).toBe(false)
  })

  it("attributes migration 037 async jobs to the guided UX report", async () => {
    delete process.env.DATABASE_URL
    installQueryResponses({ returnAsyncJobIds: true })

    const response = await POST(request("POST", { script: "037_research_guided_ux" }))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.researchGuidedUx.asyncIndexJobs).toMatchObject({
      waited: false,
      jobIds: GUIDED_INDEX_NAMES.map((name) => `job-${name}`),
      jobs: GUIDED_INDEX_NAMES.map((name) => ({ jobId: `job-${name}`, status: "submitted" })),
    })
    expect(result.researchCaptureHardening.asyncIndexJobs.jobIds).toEqual([])
  })

  it("attributes migration 038 async jobs to the standalone research cleanup report", async () => {
    delete process.env.DATABASE_URL
    installQueryResponses({ returnAsyncJobIds: true })

    const response = await POST(request("POST", { script: "038_research_blob_cleanup" }))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result.researchBlobCleanup).toMatchObject({
      preflight: {
        passed: true,
        writesExistingRows: false,
        reason: expect.stringContaining("empty table"),
      },
      asyncIndexJobs: {
        waited: false,
        jobIds: RESEARCH_CLEANUP_INDEX_NAMES.map((name) => `job-${name}`),
        jobs: RESEARCH_CLEANUP_INDEX_NAMES.map((name) => ({ jobId: `job-${name}`, status: "submitted" })),
      },
    })
    expect(result.researchGuidedUx.asyncIndexJobs.jobIds).toEqual([])
  })
})
