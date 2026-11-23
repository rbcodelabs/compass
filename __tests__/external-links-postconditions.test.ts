import { describe, expect, it } from "vitest"
import type { PoolClient } from "pg"
import { assertExternalLinksMigration, EXTERNAL_LINKS_INDEXES } from "@/lib/migrations/external-links"

type CatalogColumn = {
  column_name: string
  data_type: string
  is_nullable: string
  character_maximum_length: number | null
  datetime_precision: number | null
  column_default: string | null
  is_generated: string
  is_identity: string
}

const columns: CatalogColumn[] = [
  {"is_identity":"NO","is_generated":"NEVER","column_name":"id","data_type":"uuid","is_nullable":"NO","character_maximum_length":null,"datetime_precision":null,"column_default":"gen_random_uuid()"},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"workspace_id","data_type":"uuid","is_nullable":"NO","character_maximum_length":null,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"subject_type","data_type":"character varying","is_nullable":"NO","character_maximum_length":40,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"subject_id","data_type":"uuid","is_nullable":"NO","character_maximum_length":null,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"provider","data_type":"character varying","is_nullable":"NO","character_maximum_length":30,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"url","data_type":"character varying","is_nullable":"NO","character_maximum_length":1000,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"external_key","data_type":"character varying","is_nullable":"NO","character_maximum_length":1000,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"external_key_hash","data_type":"character varying","is_nullable":"NO","character_maximum_length":64,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"title","data_type":"character varying","is_nullable":"NO","character_maximum_length":255,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"relation","data_type":"character varying","is_nullable":"NO","character_maximum_length":20,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"status_snapshot","data_type":"text","is_nullable":"YES","character_maximum_length":null,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"source","data_type":"character varying","is_nullable":"NO","character_maximum_length":20,"datetime_precision":null,"column_default":"'UI'::character varying"},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"created_by_id","data_type":"uuid","is_nullable":"YES","character_maximum_length":null,"datetime_precision":null,"column_default":null},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"created_at","data_type":"timestamp without time zone","is_nullable":"NO","character_maximum_length":null,"datetime_precision":3,"column_default":"CURRENT_TIMESTAMP"},
  {"is_identity":"NO","is_generated":"NEVER","column_name":"updated_at","data_type":"timestamp without time zone","is_nullable":"NO","character_maximum_length":null,"datetime_precision":3,"column_default":"CURRENT_TIMESTAMP"},
]

function client(columnChange?: (rows: typeof columns) => typeof columns, indexChange?: (row: Record<string, unknown>) => Record<string, unknown>, primaryKey = ["id"]): PoolClient {
 return { query: async (_sql: string, params: unknown[]) => {
   if (_sql.includes("i.indisprimary")) return { rows: [{columns: primaryKey, valid: true, ready: true}] }
   if (params[1] === "external_links") return { rows: columnChange ? columnChange(columns.map(row => ({...row}))) : columns }
   const idx = EXTERNAL_LINKS_INDEXES.find(index => index.name === params[1])
   if (!idx) return { rows: [] }
   if (indexChange && Object.keys(indexChange({})).length === 0) return {rows: []}
   const row = { valid: true, ready: true, unique: idx.unique, table_name: idx.table, columns: idx.columns.split(","), predicate: null, expression: null }
   return { rows: [indexChange ? indexChange(row) : row] }
 }} as unknown as PoolClient
}

describe("external links catalog completion", () => {
 it("accepts the intended table and ready indexes", async () => { await expect(assertExternalLinksMigration(client(), "isolated")).resolves.toBeUndefined() })
 it("rejects the wrong primary key", async () => { await expect(assertExternalLinksMigration(client(undefined, undefined, ["subject_id"]), "isolated")).rejects.toThrow(/primary key postcondition/) })
 it.each([
  ["external_key", {character_maximum_length: 10}],
  ["external_key_hash", {character_maximum_length: 63}],
  ["external_key", {column_default: "'unexpected'::character varying"}],
  ["created_at", {datetime_precision: 6}],
  ["id", {column_default: null}],
  ["source", {column_default: "'IMPORT'::character varying"}],
  ["updated_at", {column_default: null}],
 ])("rejects shape drift on %s", async (column, drift) => {
  await expect(assertExternalLinksMigration(client(rows => rows.map(row => row.column_name === column ? {...row, ...drift} : row)), "isolated")).rejects.toThrow(/shape postcondition/)
 })
 it("rejects a missing index", async () => { await expect(assertExternalLinksMigration(client(undefined, () => ({})), "isolated")).rejects.toThrow(/index postcondition/) })
 it("rejects missing columns", async () => { await expect(assertExternalLinksMigration(client(rows => rows.filter(row => row.column_name !== "subject_id")), "isolated")).rejects.toThrow(/subject_id missing/) })
 it("rejects wrong types", async () => { await expect(assertExternalLinksMigration(client(rows => rows.map(row => row.column_name === "subject_id" ? {...row, data_type: "text"} : row)), "isolated")).rejects.toThrow(/type postcondition/) })
 it("rejects wrong nullability", async () => { await expect(assertExternalLinksMigration(client(rows => rows.map(row => row.column_name === "subject_id" ? {...row, is_nullable: "YES"} : row)), "isolated")).rejects.toThrow(/nullability postcondition/) })
 it.each([
   ["invalid", {valid: false}], ["unready", {ready: false}], ["wrong uniqueness", {unique: false}],
   ["wrong table", {table_name: "other"}], ["wrong order", {columns: ["external_key", "provider", "subject_id", "subject_type"]}],
   ["partial", {predicate: "subject_id IS NOT NULL"}], ["expression", {expression: "lower(external_key)"}],
 ])("rejects %s indexes", async (_label, drift) => { await expect(assertExternalLinksMigration(client(undefined, row => ({...row,...drift})), "isolated")).rejects.toThrow(/index postcondition/) })
})
