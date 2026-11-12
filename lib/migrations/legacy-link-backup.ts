/**
 * The pre-drop safety net for migration 116: a read-only export of the four legacy link tables and of the opportunities.linked_key_result_id
 * column into NDJSON files with a checksummed manifest, plus a loader that puts the rows back into tables an operator has recreated.
 *
 * Migration 116 cannot be undone by this application. This export is the ONLY way back (apart from a database-level backup or point-in-time
 * restore), so the runbook (docs/maintenance/entity-links-legacy-drop.md) makes it a required step before the POST. Nothing here writes to the
 * database during an export. The CLI (scripts/backup-legacy-link-tables.ts) is the only caller; it works against plain Postgres and Aurora DSQL
 * (keyset-paged plain SELECTs, no cursors, no SET, no functions beyond count).
 *
 * File layout (all 0600, never overwritten):
 *   <dir>/<schema>__<relation>.ndjson   one JSON object per line, keys are the DATABASE column names
 *   <dir>/<schema>__manifest.json       { schema, takenAt, relations: { <relation>: { file, rows, sha256 } }, entityLinksRows }
 */
import { createHash } from "node:crypto"
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline"
import { LEGACY_LINK_TABLES, LEGACY_POINTER_COLUMN, LEGACY_POINTER_RELATION, type LegacyRelation } from "@/lib/migrations/legacy-link-relations"

export type BackupQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

const PAGE = 1000
const RESTORE_BATCH = 200

type Source = { relation: LegacyRelation; table: string; columns: string; where: string }
const SOURCES: readonly Source[] = [
  ...LEGACY_LINK_TABLES.map((table): Source => ({ relation: table, table, columns: "*", where: "TRUE" })),
  // The pointer column is exported with the row id and workspace so a restore can set it back without guessing.
  { relation: LEGACY_POINTER_RELATION, table: "opportunities", columns: `id, workspace_id, ${LEGACY_POINTER_COLUMN}`, where: `${LEGACY_POINTER_COLUMN} IS NOT NULL` },
]

export type BackupManifest = {
  schema: string
  takenAt: string
  relations: Record<string, { file: string; rows: number } & ({ sha256: string } | { absent: true })>
  entityLinksRows: number
}

const ident = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`refusing unsafe identifier: ${value}`)
  return `"${value}"`
}
const fileFor = (schema: string, relation: string) => `${schema}__${relation.replace(".", "_")}.ndjson`

async function relationExists(query: BackupQuery, schema: string, source: Source): Promise<boolean> {
  if (source.relation === LEGACY_POINTER_RELATION) {
    const r = await query(`SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'opportunities' AND column_name = $2`, [schema, LEGACY_POINTER_COLUMN])
    return Number(r.rows[0]?.n ?? "0") > 0
  }
  const r = await query(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`, [schema, source.table])
  return Number(r.rows[0]?.n ?? "0") > 0
}

/**
 * Writes every legacy relation that still exists to `dir`, then re-counts each and REFUSES (throws) if a count changed while exporting, so a
 * backup of a table that is still being written to is never mistaken for a consistent one. Run it with the application not writing links
 * (right before the POST) or accept that the second count may differ and re-run.
 */
export async function exportLegacyLinks(query: BackupQuery, schema: string, dir: string, now: () => Date = () => new Date()): Promise<BackupManifest> {
  ident(schema)
  const manifestPath = path.join(dir, `${schema}__manifest.json`)
  if (existsSync(manifestPath)) throw new Error(`${manifestPath} already exists; choose a new directory (backups are never overwritten)`)
  const manifest: BackupManifest = { schema, takenAt: now().toISOString(), relations: {}, entityLinksRows: 0 }

  for (const source of SOURCES) {
    const file = fileFor(schema, source.relation)
    if (!(await relationExists(query, schema, source))) {
      manifest.relations[source.relation] = { file, rows: 0, absent: true }
      continue
    }
    const target = path.join(dir, file)
    if (existsSync(target)) throw new Error(`${target} already exists; choose a new directory (backups are never overwritten)`)
    const out = createWriteStream(target, { flags: "wx", mode: 0o600 })
    const hash = createHash("sha256")
    let rows = 0
    let after = "00000000-0000-0000-0000-000000000000"
    for (;;) {
      const page = await query(
        `SELECT ${source.columns} FROM ${ident(schema)}.${ident(source.table)} WHERE ${source.where} AND id > $1::uuid ORDER BY id LIMIT ${PAGE}`,
        [after],
      )
      if (page.rows.length === 0) break
      for (const row of page.rows) {
        const line = `${JSON.stringify(row)}\n`
        hash.update(line)
        if (!out.write(line)) await new Promise<void>((resolve) => out.once("drain", () => resolve()))
      }
      rows += page.rows.length
      after = String(page.rows[page.rows.length - 1].id)
    }
    await new Promise<void>((resolve, reject) => { out.end((error?: Error | null) => (error ? reject(error) : resolve())) })
    const counted = Number((await query(`SELECT count(*)::text AS n FROM ${ident(schema)}.${ident(source.table)} WHERE ${source.where}`)).rows[0]?.n ?? "0")
    if (counted !== rows) throw new Error(`${source.relation}: exported ${rows} rows but the table now holds ${counted}; it changed during the export. Nothing is a valid backup until a re-run agrees.`)
    manifest.relations[source.relation] = { file, rows, sha256: hash.digest("hex") }
  }
  manifest.entityLinksRows = Number((await query(`SELECT count(*)::text AS n FROM ${ident(schema)}.entity_links`)).rows[0]?.n ?? "0")
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  return manifest
}

/** Re-reads every file of a manifest and checks its row count and checksum. Throws on the first mismatch. */
export function verifyBackup(dir: string, schema: string): BackupManifest {
  const manifest = JSON.parse(readFileSync(path.join(dir, `${schema}__manifest.json`), "utf8")) as BackupManifest
  for (const [relation, entry] of Object.entries(manifest.relations)) {
    if ("absent" in entry) continue
    const text = readFileSync(path.join(dir, entry.file), "utf8")
    const rows = text === "" ? 0 : text.split("\n").length - 1
    if (rows !== entry.rows) throw new Error(`${relation}: ${entry.file} has ${rows} lines, the manifest says ${entry.rows}`)
    if (createHash("sha256").update(text).digest("hex") !== entry.sha256) throw new Error(`${relation}: ${entry.file} does not match its checksum`)
  }
  return manifest
}

/**
 * Loads the exported rows back. The tables (and, for the pointer, the column) must already exist: recreate them from the shipped migrations
 * (027 task_links, 034 artifact_links, 071 the two typed link tables, 001 the opportunities column) as the runbook describes. Existing rows
 * with the same id are skipped by the caller's choice of an empty target; this loader only INSERTs (and UPDATEs the pointer for its row ids).
 */
export async function restoreLegacyLinks(query: BackupQuery, schema: string, dir: string): Promise<Record<string, number>> {
  const manifest = verifyBackup(dir, schema)
  const restored: Record<string, number> = {}
  for (const source of SOURCES) {
    const entry = manifest.relations[source.relation]
    if (!entry || "absent" in entry || entry.rows === 0) continue
    let batch: Record<string, unknown>[] = []
    let total = 0
    const flush = async () => {
      if (batch.length === 0) return
      if (source.relation === LEGACY_POINTER_RELATION) {
        for (const row of batch) {
          await query(`UPDATE ${ident(schema)}.opportunities SET ${ident(LEGACY_POINTER_COLUMN)} = $1::uuid WHERE id = $2::uuid`, [row[LEGACY_POINTER_COLUMN], row.id])
        }
      } else {
        const columns = Object.keys(batch[0])
        const values = batch.map((_, r) => `(${columns.map((_c, c) => `$${r * columns.length + c + 1}`).join(", ")})`).join(", ")
        await query(`INSERT INTO ${ident(schema)}.${ident(source.table)} (${columns.map(ident).join(", ")}) VALUES ${values}`, batch.flatMap((row) => columns.map((column) => row[column])))
      }
      total += batch.length
      batch = []
    }
    const lines = createInterface({ input: createReadStream(path.join(dir, entry.file), "utf8"), crlfDelay: Infinity })
    for await (const line of lines) {
      if (!line) continue
      batch.push(JSON.parse(line) as Record<string, unknown>)
      if (batch.length >= RESTORE_BATCH) await flush()
    }
    await flush()
    restored[source.relation] = total
  }
  return restored
}
