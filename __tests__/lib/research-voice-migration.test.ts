import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { voiceMigrationCatalog, validateVoiceMigrationCatalog } from "@/lib/research-voice-migration"

const sql = readFileSync(new URL("../../prisma/migrations/047_research_voice_control_plane/migration.sql", import.meta.url), "utf8")
const expected = voiceMigrationCatalog(sql)
const complete = () => ({
  tables: expected.tables,
  columns: expected.columns,
  indexes: expected.indexes.map((index) => ({ ...index, valid: true, nullsNotDistinct: false, predicate: null, expression: null })),
  primaryKeys: expected.tables.map((table) => ({ table, columns: ["id"], valid: true })),
})

describe("047 partial catalog admission", () => {
  it("admits a fresh catalog and the exact completed catalog", () => {
    expect(() => validateVoiceMigrationCatalog(expected, { tables: [], columns: [], indexes: [], primaryKeys: [] }, false)).not.toThrow()
    expect(() => validateVoiceMigrationCatalog(expected, complete(), true)).not.toThrow()
  })
  it("admits the observed partial call table and first ACTIVE index", () => {
    const actual = complete()
    actual.tables = ["research_voice_calls"]
    actual.columns = actual.columns.filter((column) => column.table !== "research_voice_commands" && column.table !== "research_voice_events")
    actual.indexes = actual.indexes.slice(0, 1)
    actual.primaryKeys = actual.primaryKeys.slice(0, 1)
    expect(() => validateVoiceMigrationCatalog(expected, actual, false)).not.toThrow()
    expect(() => validateVoiceMigrationCatalog(expected, actual, true)).toThrow()
  })
  it.each(["type", "nullable", "default", "missing", "extra", "primaryKey"])("rejects %s drift before writes", (kind) => {
    const actual = structuredClone(complete())
    const column = actual.columns.find((item) => item.table === "research_voice_calls")!
    if (kind === "type") column.type = "text"
    if (kind === "nullable") column.nullable = true
    if (kind === "default") column.default = "wrong()"
    if (kind === "missing") actual.columns = actual.columns.filter((item) => item !== column)
    if (kind === "extra") actual.columns.push({ ...column, name: "unexpected" })
    if (kind === "primaryKey") actual.primaryKeys[0].columns = ["session_id"]
    expect(() => validateVoiceMigrationCatalog(expected, actual, false)).toThrow(/047/)
  })
  it.each(["table", "keys", "unique", "invalid", "predicate", "expression", "nullsNotDistinct"])("rejects %s index drift", (kind) => {
    const actual = structuredClone(complete())
    const index = actual.indexes[0]
    if (kind === "table") index.table = "wrong"
    if (kind === "keys") index.columns.reverse()
    if (kind === "unique") index.unique = false
    if (kind === "invalid") index.valid = false
    if (kind === "nullsNotDistinct") index.nullsNotDistinct = true
    if (kind === "predicate") Object.assign(index, { predicate: "id IS NOT NULL" })
    if (kind === "expression") Object.assign(index, { expression: "lower(id)" })
    expect(() => validateVoiceMigrationCatalog(expected, actual, false)).toThrow(/047/)
  })
  it("accepts nullable backfill columns before defaults but requires defaults at completion", () => {
    const actual = structuredClone(complete())
    actual.columns.find((column) => column.name === "voice_count")!.default = null
    expect(() => validateVoiceMigrationCatalog(expected, actual, false)).not.toThrow()
    expect(() => validateVoiceMigrationCatalog(expected, actual, true)).toThrow()
  })
})
