import type { PoolClient } from "pg"

type Column = { table: string; name: string; type: string; nullable: boolean; default: string | null; added: boolean }
type Index = { name: string; table: string; columns: string[]; unique: boolean }
type Expected = { tables: string[]; columns: Column[]; indexes: Index[]; migrationName?: string }
type Actual = {
  tables: string[]
  columns: Column[]
  indexes: (Index & { valid: boolean; nullsNotDistinct: boolean; predicate: string | null; expression: string | null })[]
  primaryKeys: { table: string; columns: string[]; valid: boolean }[]
}
const normalizeDefault = (value: string | null) => value?.replace(/::(?:character varying|text|integer)\b/g, "").replace(/^\((.*)\)$/, "$1").trim() ?? null
const normalizeType = (value: string) => value.toLowerCase().replace(/^varchar/, "character varying").replace(/^timestamptz$/, "timestamp with time zone")

// Deliberately accepts only the checked-in voice migration grammar, not arbitrary SQL.
export function voiceMigrationCatalog(sql: string, migrationName = "047"): Expected {
  const expected: Expected = { tables: [], columns: [], indexes: [], migrationName }
  const parseColumn = (table: string, declaration: string, added: boolean) => {
    const match = declaration.trim().match(/^(\w+)\s+(UUID|INTEGER|TEXT|TIMESTAMPTZ|VARCHAR\(\d+\))(.*)$/i)
    if (!match) throw new Error(`Migration ${migrationName} unsupported column declaration`)
    expected.columns.push({ table, name: match[1], type: normalizeType(match[2]), nullable: !/NOT NULL|PRIMARY KEY/i.test(match[3]), default: normalizeDefault(match[3].match(/DEFAULT\s+(.+)$/i)?.[1] ?? null), added })
  }
  for (const statement of sql.replace(/--[^\n]*/g, "").split(";").map((part) => part.trim()).filter(Boolean)) {
    const table = statement.match(/^CREATE TABLE (\w+) \(([\s\S]*)\)$/)
    const column = statement.match(/^ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS ([\s\S]*)$/)
    const defaultValue = statement.match(/^ALTER TABLE (\w+) ALTER COLUMN (\w+) SET DEFAULT 0$/)
    const index = statement.match(/^CREATE (UNIQUE )?INDEX ASYNC (\w+) ON (\w+) \(([^)]+)\)$/)
    if (table) { expected.tables.push(table[1]); for (const part of table[2].split(/,\s*/)) parseColumn(table[1], part, false) }
    else if (column) parseColumn(column[1], column[2], true)
    else if (defaultValue) {
      const target = expected.columns.find((item) => item.table === defaultValue[1] && item.name === defaultValue[2])
      if (!target) throw new Error(`Migration ${migrationName} unsupported default declaration`)
      target.default = "0"
    } else if (index) expected.indexes.push({ name: index[2], table: index[3], columns: index[4].split(/,\s*/), unique: Boolean(index[1]) })
    else throw new Error(`Migration ${migrationName} unsupported DDL`)
  }
  return expected
}

export function validateVoiceMigrationCatalog(expected: Expected, actual: Actual, complete: boolean) {
  const fail = (object: string): never => { throw new Error(`Migration ${expected.migrationName ?? "047"} catalog mismatch: ${object}`) }
  for (const table of expected.tables) {
    if (!actual.tables.includes(table)) { if (complete) fail(table); continue }
    const key = actual.primaryKeys.filter((item) => item.table === table)
    if (key.length !== 1 || !key[0].valid || key[0].columns.join(",") !== "id") fail(`${table} primary key`)
    for (const column of actual.columns.filter((item) => item.table === table)) {
      if (!expected.columns.some((item) => item.table === table && item.name === column.name)) fail(`${table}.${column.name}`)
    }
  }
  for (const column of expected.columns) {
    const found = actual.columns.find((item) => item.table === column.table && item.name === column.name)
    if (!found) {
      if (complete || (!column.added && actual.tables.includes(column.table))) fail(`${column.table}.${column.name}`)
      continue
    }
    const defaultMatches = normalizeDefault(found.default) === column.default || (!complete && column.added && column.default === "0" && found.default === null)
    if (normalizeType(found.type) !== column.type || found.nullable !== column.nullable || !defaultMatches) fail(`${column.table}.${column.name}`)
  }
  for (const index of expected.indexes) {
    const found = actual.indexes.find((item) => item.name === index.name)
    if (!found) { if (complete) fail(index.name); continue }
    if (!found.valid || found.nullsNotDistinct !== false || found.table !== index.table || found.unique !== index.unique || found.columns.join(",") !== index.columns.join(",") || found.predicate !== null || found.expression !== null) fail(index.name)
  }
}

export async function inspectVoiceMigrationCatalog(client: PoolClient, schema: string, expected: Expected, complete = false) {
  const tables = [...new Set(expected.columns.map((column) => column.table))]
  const [relations, columns, indexes, primaryKeys] = await Promise.all([
    client.query<{ name: string; kind: string }>(`SELECT c.relname name, c.relkind kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`, [schema, expected.tables]),
    client.query<Column>(`SELECT t.relname AS "table", a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS "default"
      FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=t.oid AND d.adnum=a.attnum
      WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND a.attnum>0 AND NOT a.attisdropped`, [schema, tables]),
    client.query<Actual["indexes"][number]>(`SELECT c.relname name, t.relname AS "table", i.indisvalid valid, i.indisunique AS "unique", i.indnullsnotdistinct AS "nullsNotDistinct", pg_get_expr(i.indpred,i.indrelid) predicate, pg_get_expr(i.indexprs,i.indrelid) expression,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.ordinal<=i.indnkeyatts ORDER BY k.ordinal) AS columns
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class t ON t.oid=i.indrelid WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`, [schema, expected.indexes.map((index) => index.name)]),
    client.query<Actual["primaryKeys"][number]>(`SELECT t.relname AS "table", i.indisvalid valid,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ordinal) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE k.ordinal<=i.indnkeyatts ORDER BY k.ordinal) AS columns
      FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND i.indisprimary`, [schema, expected.tables]),
  ])
  if (relations.rows.some((row) => row.kind !== "r")) throw new Error(`Migration ${expected.migrationName ?? "047"} expected ordinary tables`)
  const actual = { tables: relations.rows.map((row) => row.name), columns: columns.rows, indexes: indexes.rows, primaryKeys: primaryKeys.rows }
  validateVoiceMigrationCatalog(expected, actual, complete)
  return actual
}
