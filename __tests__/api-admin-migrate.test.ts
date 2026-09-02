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

import { GET, POST, getDecisionGateExpectedCatalog } from "@/app/api/admin/migrate/route"

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
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sqlValue, values) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: catalog.migrations.map((name) => ({ name })) }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        { column_name: "now_commitment_provenance", is_nullable: "NO", column_default: "'LEGACY_UNGATED'::character varying" },
        { column_name: "now_decision_record_id", is_nullable: "YES", column_default: null },
      ] }
      if (sql.includes("pg_get_indexdef")) return { rows: catalog.indexes.map((index) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) }
      if (sql.includes("FROM pg_constraint")) return { rows: catalog.constraints.map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.definition, key_columns: constraint.keyColumns })) }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "4", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [{ plan_violations: "0", reservation_violations: "0" }] }
      return fallback(sqlValue, values)
    })
    const result = (await (await GET(request("GET"))).json()).decisionGateInfrastructure
    expect(catalog.constraints.find((item) => item.name === "idx_release_runs_scope_fingerprint")?.definition).toContain("pull_request_number")
    expect(result.constraints.filter((item: { type: string }) => item.type === "c")).toHaveLength(3)
    expect(result.migrationReady).toBe(true)
  })

  it("accepts Aurora DSQL primary-key INCLUDE rendering without weakening other constraint comparisons", async () => {
    const catalog = getDecisionGateExpectedCatalog()
    const fallback = mocks.query.getMockImplementation()!
    mocks.query.mockImplementation(async (sqlValue, values) => {
      const sql = String(sqlValue)
      if (sql.includes("migration_name as name")) return { rows: catalog.migrations.map((name) => ({ name })) }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: catalog.tables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        { column_name: "now_commitment_provenance", is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        { column_name: "now_decision_record_id", is_nullable: "YES", column_default: null },
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

  it("waits for every repair async job and verifies postconditions before finishing the receipt", async () => {
    delete process.env.DATABASE_URL
    const catalog = getDecisionGateExpectedCatalog()
    const repairTables: string[] = catalog.tables.slice(0, 5)
    const repairIndexes = catalog.indexes.filter((index) => index.name.startsWith("idx_review_") || index.name.startsWith("idx_decision_"))
    const repairConstraints = catalog.constraints.filter((constraint) =>
      repairTables.includes(constraint.table) || constraint.name === "chk_roadmap_items_commitment_provenance_not_null"
    )
    let repaired = false
    let job = 0
    mocks.query.mockImplementation(async (sqlValue: unknown, values?: unknown[]) => {
      const sql = String(sqlValue)
      if (sql.includes("SELECT migration_name FROM")) return { rows: [{ migration_name: "039_native_decision_gates" }] }
      if (sql.includes("information_schema.tables") && Array.isArray(values?.[1]) && values[1].includes("review_requests")) return { rows: repairTables.map((table_name) => ({ table_name })) }
      if (sql.includes("information_schema.columns") && sql.includes("roadmap_items")) return { rows: [
        { column_name: "now_commitment_provenance", is_nullable: "YES", column_default: "'LEGACY_UNGATED'::character varying" },
        ...(repaired ? [{ column_name: "now_decision_record_id", is_nullable: "YES", column_default: null }] : []),
      ] }
      if (sql.includes("FROM pg_constraint")) return { rows: repairConstraints
        .filter((constraint) => repaired || constraint.name !== "chk_roadmap_items_commitment_provenance_not_null")
        .map((constraint) => ({ constraint_name: constraint.name, table_name: constraint.table, constraint_type: constraint.type, valid: true, definition: constraint.definition, key_columns: constraint.keyColumns })) }
      if (sql.includes("pg_get_indexdef")) return { rows: repaired ? repairIndexes.map((index) => ({ name: index.name, table_name: index.table, valid: true, unique: index.unique, key_columns: index.keyColumns, definition: index.definition })) : [] }
      if (sql.includes("legacy_link_drift")) return { rows: [{ total: "4", null_count: "0", unknown_count: "0", legacy_link_drift: "0" }] }
      if (sql.includes("plan_violations")) return { rows: [] }
      if (sql.includes("pg_column_size")) return { rows: [] }
      if (/ALTER TABLE ASYNC|CREATE INDEX ASYNC/i.test(sql)) return { rows: [{ job_id: `repair-job-${++job}` }] }
      if (sql.includes("sys.wait_for_job")) {
        if (job === 8) repaired = true
        return { rows: [{ succeeded: true }] }
      }
      return { rows: [] }
    })

    const response = await POST(request("POST", { script: "042_native_decision_gates_repair" }))

    expect(response.status).toBe(200)
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes("sys.wait_for_job"))).toHaveLength(8)
    const calls = mocks.query.mock.calls.map(([sql]) => String(sql))
    expect(calls.findIndex((sql) => sql.includes("SET finished_at"))).toBeGreaterThan(calls.map((sql, index) => sql.includes("sys.wait_for_job") ? index : -1).at(-1)!)
  })

  it("returns migration 036 index validity after an explicit apply", async () => {
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
      message: expect.stringContaining("036_research_capture_hardening applied"),
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
