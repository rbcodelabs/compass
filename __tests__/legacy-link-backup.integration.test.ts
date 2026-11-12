import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { exportLegacyLinks, restoreLegacyLinks, verifyBackup, type BackupQuery } from "@/lib/migrations/legacy-link-backup"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * The pre-drop backup (export, verify, restore) against real Postgres on a throwaway schema of the local compass_e2e database.
 * Set INTEGRATION_TEST_DATABASE_URL to enable. NEVER point it at a real database.
 */
const databaseUrl = integrationDatabaseUrl

describe.skipIf(!databaseUrl)("legacy link backup (export / verify / restore)", () => {
  const schema = `legacy_backup_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  const previous = process.env.DATABASE_URL
  const dirs: string[] = []
  const tmp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "legacy-backup-")); dirs.push(dir); return dir }
  const query: BackupQuery = async (sql, params) => pool.query(sql, params as unknown[])
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("$S", `"${schema}"`), params)
  const n = async (sql: string) => Number((await q(sql)).rows[0].n)
  const ws = randomUUID()
  const kr = randomUUID()
  let opportunity = ""
  let owned = false
  const TOTAL = 1234 // > one 1000-row page, so the keyset paging is exercised

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) throw new Error("Only isolated local compass_e2e is allowed")
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    const replay = await replayAllMigrations(pool, schema)
    expect(replay.status, JSON.stringify(await replay.json())).toBe(200)
    opportunity = (await q(`INSERT INTO $S.opportunities(workspace_id,title,linked_key_result_id) VALUES ($1,'opp',$2) RETURNING id`, [ws, kr])).rows[0].id
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id,source,created_at) SELECT gen_random_uuid(),'DOC',gen_random_uuid(),'UI','2024-05-06 07:08:09.123' FROM generate_series(1,${TOTAL})`)
    await q(`INSERT INTO $S.artifact_links(workspace_id,artifact_id,linked_type,linked_id) VALUES ($1,gen_random_uuid(),'SOLUTION',gen_random_uuid())`, [ws])
    await q(`INSERT INTO $S.opportunity_objective_links(workspace_id,opportunity_id,objective_id,origin) VALUES ($1,gen_random_uuid(),gen_random_uuid(),'DIRECT')`, [ws])
    await q(`INSERT INTO $S.solution_key_result_links(workspace_id,solution_id,key_result_id) VALUES ($1,gen_random_uuid(),gen_random_uuid())`, [ws])
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("exports every relation across pages, with a manifest that verifies, and never overwrites", async () => {
    const dir = tmp()
    const manifest = await exportLegacyLinks(query, schema, dir)
    expect(Object.fromEntries(Object.entries(manifest.relations).map(([name, entry]) => [name, entry.rows]))).toEqual({
      task_links: TOTAL, artifact_links: 1, opportunity_objective_links: 1, solution_key_result_links: 1, "opportunities.linked_key_result_id": 1,
    })
    expect(manifest.entityLinksRows).toBe(0)
    expect(verifyBackup(dir, schema).relations.task_links).toMatchObject({ rows: TOTAL })
    const lines = readFileSync(path.join(dir, `${schema}__task_links.ndjson`), "utf8").trim().split("\n")
    expect(lines).toHaveLength(TOTAL)
    expect(JSON.parse(lines[0])).toMatchObject({ linked_type: "DOC", source: "UI", created_at: "2024-05-06T07:08:09.123Z" })
    const pointer = JSON.parse(readFileSync(path.join(dir, `${schema}__opportunities_linked_key_result_id.ndjson`), "utf8").trim())
    expect(pointer).toEqual({ id: opportunity, workspace_id: ws, linked_key_result_id: kr })
    await expect(exportLegacyLinks(query, schema, dir)).rejects.toThrow(/already exists/)
  }, 120_000)

  it("verify catches a tampered or truncated file", async () => {
    const dir = tmp()
    await exportLegacyLinks(query, schema, dir)
    const file = path.join(dir, `${schema}__artifact_links.ndjson`)
    writeFileSync(file, readFileSync(file, "utf8").replace("SOLUTION", "SOLUTIOn"))
    expect(() => verifyBackup(dir, schema)).toThrow(/does not match its checksum/)
    writeFileSync(file, "")
    expect(() => verifyBackup(dir, schema)).toThrow(/has 0 lines, the manifest says 1/)
  }, 120_000)

  it("restore puts the rows and the pointer back exactly (ids, timestamps included)", async () => {
    const dir = tmp()
    await exportLegacyLinks(query, schema, dir)
    const snapshot = async () => (await q(`SELECT (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM $S.task_links t) AS tl, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM $S.artifact_links t) AS al,
      (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM $S.opportunity_objective_links t) AS ol, (SELECT md5(string_agg(t::text, ',' ORDER BY id)) FROM $S.solution_key_result_links t) AS sl,
      (SELECT linked_key_result_id FROM $S.opportunities WHERE id = '${opportunity}') AS kr`)).rows[0]
    const before = await snapshot()
    await q(`DELETE FROM $S.task_links`); await q(`DELETE FROM $S.artifact_links`); await q(`DELETE FROM $S.opportunity_objective_links`); await q(`DELETE FROM $S.solution_key_result_links`)
    await q(`UPDATE $S.opportunities SET linked_key_result_id = NULL`)
    expect(await n(`SELECT count(*)::text AS n FROM $S.task_links`)).toBe(0)
    const restored = await restoreLegacyLinks(query, schema, dir)
    expect(restored).toEqual({ task_links: TOTAL, artifact_links: 1, opportunity_objective_links: 1, solution_key_result_links: 1, "opportunities.linked_key_result_id": 1 })
    expect(await snapshot()).toEqual(before)
  }, 120_000)

  it("refuses to call a backup valid when a table changed while it was being exported", async () => {
    const dir = tmp()
    let calls = 0
    const racing: BackupQuery = async (sql, params) => {
      // After the first page of task_links is read, another writer adds a row, so the final count disagrees.
      if (/FROM "[^"]+"\."task_links" WHERE TRUE AND id >/.test(sql) && ++calls === 2) await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) VALUES (gen_random_uuid(),'DOC',gen_random_uuid())`)
      return query(sql, params)
    }
    await expect(exportLegacyLinks(racing, schema, dir)).rejects.toThrow(/changed during the export/)
  }, 120_000)

  it("a dropped relation is recorded as absent, not as an error", async () => {
    const solo = `legacy_backup_test_absent_${randomUUID().replaceAll("-", "")}`
    await pool.query(`CREATE SCHEMA "${solo}"`)
    try {
      await pool.query(`CREATE TABLE "${solo}".opportunities(id uuid primary key)`)
      await pool.query(`CREATE TABLE "${solo}".entity_links(id uuid primary key)`)
      const dir = tmp()
      const manifest = await exportLegacyLinks(query, solo, dir)
      expect(Object.values(manifest.relations).every((entry) => "absent" in entry)).toBe(true)
      expect(verifyBackup(dir, solo)).toBeTruthy()
    } finally {
      await pool.query(`DROP SCHEMA "${solo}" CASCADE`)
    }
  }, 60_000)
})
