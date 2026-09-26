import { afterEach, describe, expect, it, vi } from "vitest"
import type { Pool } from "pg"
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner"

vi.mock("@/lib/migrations/legacy-decision-review-repair", () => ({
  getLegacyDecisionReviewRepairStatus: vi.fn().mockResolvedValue({ workspaceStatus: "NOT_PRESENT" }),
  LEGACY_DECISION_REVIEW_REPAIR_MIGRATION: "048_legacy_decision_review_repair",
}))

const migration = "059_geode_document_storage"
const indexName = "doc_operations_workspace_id_operation_id_key"
const columns = [
  ["docs", "storage_provider", "character varying", 20], ["docs", "content_ref", "text", null], ["docs", "revision", "uuid", null],
  ["doc_versions", "storage_provider", "character varying", 20], ["doc_versions", "content_ref", "text", null],
  ...["id", "workspace_id", "operation_id", "doc_id"].map(c => ["doc_operations", c, "uuid", null]),
  ["doc_operations", "payload_digest", "character varying", 64], ["doc_operations", "result", "text", null], ["doc_operations", "created_at", "timestamp without time zone", null],
  ...["id", "workspace_id"].map(c => ["doc_storage_objects", c, "uuid", null]),
  ["doc_storage_objects", "pathname", "text", null], ["doc_storage_objects", "created_at", "timestamp without time zone", null],
].map(([table_name, column_name, data_type, character_maximum_length]) => ({
  table_name, column_name, data_type, character_maximum_length,
  is_nullable: ["docs", "doc_versions"].includes(String(table_name)) ? "YES" : "NO",
  column_default: column_name === "created_at" ? "CURRENT_TIMESTAMP" : null,
}))

function database(options: { absent?: boolean; malformedTable?: boolean; missing?: string; drift?: boolean; applied?: boolean; job?: string; noJob?: boolean; ddlFailure?: boolean; queryFailure?: boolean; wrongIndex?: boolean; notReady?: boolean; wrongType?: boolean; wrongDefault?: boolean; predicate?: boolean; expression?: boolean; missingPrimaryKey?: boolean; wrongPrimaryKey?: boolean; invalidPrimaryKey?: boolean } = {}) {
  const query = vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    if (sql.includes("migration_name as name")) return { rows: options.applied ? [{ name: migration, applied: true }] : [] }
    if (sql.includes("SELECT migration_name FROM")) return { rows: options.applied ? [{ migration_name: migration }] : [] }
    if (sql.includes("information_schema.tables") && Array.isArray(params[1]) && params[1].includes("doc_operations")) return { rows: options.absent && !options.malformedTable ? [] : [{ table_name: "doc_operations" }, { table_name: "doc_storage_objects" }] }
    if (sql.includes("information_schema.columns") && Array.isArray(params[1]) && params[1].includes("docs")) {
      if (options.queryFailure) throw new Error("catalog unavailable")
      return { rows: options.absent ? [] : columns.filter(c => `${c.table_name}.${c.column_name}` !== options.missing).map(c => c.column_name === "revision" ? { ...c, is_nullable: options.drift ? "NO" : c.is_nullable, data_type: options.wrongType ? "text" : c.data_type, column_default: options.wrongDefault ? "gen_random_uuid()" : c.column_default } : c) }
    }
    if (sql.includes("pg_index") && params[1] === indexName) return { rows: options.absent ? [] : [{ valid: true, ready: !options.notReady, unique: true, table_name: "doc_operations", columns: options.wrongIndex ? ["doc_id"] : ["workspace_id", "operation_id"], predicate: options.predicate ? "doc_id IS NOT NULL" : null, expression: options.expression ? "lower(operation_id)" : null }] }
    if (sql.includes("i.indisprimary")) return { rows: options.absent || options.missingPrimaryKey ? [] : ["doc_operations", "doc_storage_objects"].map(table_name => ({ table_name, valid: !options.invalidPrimaryKey, ready: true, columns: options.wrongPrimaryKey ? ["workspace_id"] : ["id"] })) }
    if (sql.startsWith("ALTER TABLE docs") && options.ddlFailure) throw new Error("injected partial DDL failure")
    if (/CREATE UNIQUE INDEX ASYNC/.test(sql)) return { rows: options.noJob ? [] : [{ job_id: "synthetic-job" }] }
    if (sql === "SELECT status FROM sys.jobs WHERE job_id = $1") return { rows: [{ status: options.job ?? "completed" }] }
    return { rows: [] }
  })
  const release = vi.fn()
  return { query, release, pool: { connect: async () => ({ query, release }) } as unknown as Pool }
}

afterEach(() => vi.unstubAllEnvs())

describe("migration 059 catalog status", () => {
  it("reports absent as not yet ready without failing the global status endpoint", async () => {
    const db = database({ absent: true })
    const response = await getMigrationStatus(db.pool, "compass_preview")
    expect(response.status).toBe(200)
    expect((await response.json()).geodeDocumentStorage).toMatchObject({ status: "absent", ready: false, receiptApplied: false, drift: false })
    expect(db.query.mock.calls.every(([sql]) => !/^(CREATE|ALTER|INSERT|UPDATE|DELETE)/.test(sql.trim()))).toBe(true)
  })
  it("reports complete catalog and exact manifest registration", async () => {
    const response = await getMigrationStatus(database().pool, "compass_preview")
    const body = await response.json()
    expect(body.manifest).toContain(migration)
    expect(body.geodeDocumentStorage).toMatchObject({ status: "complete", ready: true })
  })
  it.each([{ missing: "docs.revision" }, { drift: true }, { wrongIndex: true }, { notReady: true }, { wrongType: true }, { wrongDefault: true }, { predicate: true }, { expression: true }, { missingPrimaryKey: true }, { wrongPrimaryKey: true }, { invalidPrimaryKey: true }])("reports already-receipted catalog drift: %j", async options => {
    const response = await getMigrationStatus(database({ ...options, applied: true }).pool, "compass_preview")
    expect((await response.json()).geodeDocumentStorage).toMatchObject({ status: "partial", ready: false, receiptApplied: true, drift: true })
  })
  it("does not turn an inaccessible catalog into absent", async () => {
    await expect(getMigrationStatus(database({ queryFailure: true }).pool, "compass_preview")).rejects.toThrow("catalog unavailable")
  })
  it("classifies a new table without expected columns as partial, not absent", async () => {
    const response = await getMigrationStatus(database({ absent: true, malformedTable: true }).pool, "compass_preview")
    expect((await response.json()).geodeDocumentStorage.status).toBe("partial")
  })
  it("compares key attributes only, allowing DSQL implicit included columns", async () => {
    const db = database()
    await getMigrationStatus(db.pool, "compass_preview")
    const keyQueries = db.query.mock.calls.filter(([sql, params]) => sql.includes("unnest(i.indkey)") && (params?.[1] === indexName || Array.isArray(params?.[1]) && params[1].includes("doc_operations"))).map(([sql]) => sql)
    expect(keyQueries).toHaveLength(2)
    for (const sql of keyQueries) expect(sql).toContain("k.position <= i.indnkeyatts")
  })
})

describe("migration 059 runner", () => {
  it("waits for the DSQL unique index before finishing only its attempt", async () => {
    vi.stubEnv("DATABASE_URL", "")
    const db = database()
    const response = await applyMigrations(db.pool, "compass_preview", migration)
    expect(response.status).toBe(200)
    const calls = db.query.mock.calls.map(([sql]) => sql)
    expect(calls).toContain("CALL sys.wait_for_job($1)")
    const finished = calls.findIndex(sql => sql.includes("SET finished_at"))
    expect(finished).toBeGreaterThan(calls.findIndex(sql => sql.includes("pg_index") && sql.includes("indisunique")))
    expect(calls[finished]).toContain("WHERE id = $1")
  })
  it.each(["failed", "running", "submitted"])("leaves unfinished receipt for %s async index", async job => {
    vi.stubEnv("DATABASE_URL", "")
    const db = database({ job })
    expect((await applyMigrations(db.pool, "compass_preview", migration)).status).toBe(500)
    expect(db.query.mock.calls.some(([sql]) => sql.includes("INSERT INTO") && sql.includes("_prisma_migrations"))).toBe(true)
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET finished_at"))).toBe(false)
  })
  it.each([{ ddlFailure: true }, { missing: "docs.revision" }, { wrongIndex: true }])("does not finish partial or invalid catalog: %j", async options => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/compass_e2e")
    const db = database(options)
    expect((await applyMigrations(db.pool, "compass_dev", migration)).status).toBe(500)
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET finished_at"))).toBe(false)
  })
  it("accepts an existing valid index on resumable IF NOT EXISTS without a new async job", async () => {
    vi.stubEnv("DATABASE_URL", "")
    const db = database({ noJob: true })
    expect((await applyMigrations(db.pool, "compass_preview", migration)).status).toBe(200)
    expect(db.query.mock.calls.some(([sql]) => sql.includes("SET finished_at"))).toBe(true)
  })
  it("does not create another attempt after a finished receipt", async () => {
    const db = database({ applied: true })
    expect((await applyMigrations(db.pool, "compass_preview", migration)).status).toBe(200)
    expect(db.query.mock.calls.some(([sql]) => sql.startsWith("ALTER TABLE docs") || sql.includes("INSERT INTO"))).toBe(false)
  })
})
