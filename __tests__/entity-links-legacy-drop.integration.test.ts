import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner"
import { dropLegacyLinkRelations } from "@/lib/migrations/entity-links-legacy-drop"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * 116 (the irreversible drop of the legacy link tables and opportunities.linked_key_result_id) through the registered runner on a
 * THROWAWAY schema of the local compass_e2e database, seeded with legacy rows AND their entity_links twins. Proves:
 *   - it is explicit-only (an untargeted POST skips it);
 *   - the preflight REFUSES, drops nothing and records no receipt while a live legacy row has no entity_links twin (or 115 is not applied);
 *   - once the twin exists the drop succeeds, the receipt is recorded, entity_links is untouched and the data in the surviving tables is intact;
 *   - the status GET and the older explicit-only migrations work against the schema WITHOUT the tables (no query touches a dropped relation);
 *   - a rerun is a no-op, and a half-finished drop resumes.
 * Set INTEGRATION_TEST_DATABASE_URL to the local compass_e2e database (Postgres 16) to enable. NEVER point it at a real database.
 */
const databaseUrl = integrationDatabaseUrl
const NAME = "116_entity_links_drop_legacy_tables"
const LEGACY = ["task_links", "artifact_links", "opportunity_objective_links", "solution_key_result_links"]
type StatusJson = {
  entityLinksReadParity: { error?: string; totalMismatches: number; families: Record<string, { legacyDropped?: boolean }> }
  entityLinksLegacyDrop: { dropped: boolean; ready: boolean; blockers: string[]; present: string[] }
  appliedMigrations: string[]
  linkIntegrity: unknown
} & Record<string, unknown>

describe.skipIf(!databaseUrl)("116 entity_links legacy drop through the registered runner", () => {
  const schema = `entity_links_drop_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  let owned = false
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("$S", `"${schema}"`), params)
  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n)
  const run = async (script?: string) => {
    let last = await applyMigrations(pool, schema, script)
    for (let i = 0; i < 100 && last.status === 202; i++) last = await applyMigrations(pool, schema, script)
    return last
  }
  const present = async () =>
    (await q(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY 1`, [schema, LEGACY])).rows.map((r) => r.table_name as string)
  const hasColumn = async () => (await count(`SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'opportunities' AND column_name = 'linked_key_result_id'`, [schema])) === 1
  const receipt = (name: string) => count(`SELECT count(*)::text AS n FROM $S._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, [name])
  const entityLinks = () => count(`SELECT count(*)::text AS n FROM $S.entity_links`)

  const ws = randomUUID()
  const ids = {} as Record<string, string>
  const insert = async (sql: string, params: unknown[]) => (await q(`${sql} RETURNING id`, params)).rows[0].id as string
  const twin = (linkType: string, fromType: string, fromId: string, toType: string, toId: string, origin = "DIRECT") =>
    q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [ws, linkType, fromType, fromId, toType, toId, origin])

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    const replay = await replayAllMigrations(pool, schema)
    expect(replay.status, JSON.stringify(await replay.json())).toBe(200)

    ids.objective = await insert(`INSERT INTO $S.objectives(workspace_id,title) VALUES ($1,'o')`, [ws])
    ids.kr = await insert(`INSERT INTO $S.key_results(objective_id,title,target) VALUES ($1,'kr',1)`, [ids.objective])
    ids.opp = await insert(`INSERT INTO $S.opportunities(workspace_id,title,linked_key_result_id) VALUES ($1,'opp',$2)`, [ws, ids.kr])
    ids.oppPlain = await insert(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'plain')`, [ws])
    ids.sol = await insert(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) VALUES ($1,$2,'sol')`, [ws, ids.opp])
    ids.art = await insert(`INSERT INTO $S.artifacts(workspace_id,title,source_type) VALUES ($1,'a','EXTERNAL_LINK')`, [ws])
    ids.task = await insert(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'t')`, [ws])
    ids.doc = await insert(`INSERT INTO $S.docs(workspace_id,title) VALUES ($1,'d')`, [ws])
    ids.comment = await insert(`INSERT INTO $S.comments(workspace_id,target_type,target_id,body,author_name) VALUES ($1,'DOC',$2,'b','a')`, [ws, ids.doc])

    // Legacy rows, one per table / kind.
    await q(`INSERT INTO $S.solution_key_result_links(workspace_id,solution_id,key_result_id) VALUES ($1,$2,$3)`, [ws, ids.sol, ids.kr])
    await q(`INSERT INTO $S.opportunity_objective_links(workspace_id,opportunity_id,objective_id,origin) VALUES ($1,$2,$3,'DIRECT')`, [ws, ids.oppPlain, ids.objective])
    await q(`INSERT INTO $S.artifact_links(workspace_id,artifact_id,linked_type,linked_id) VALUES ($1,$2,'SOLUTION',$3)`, [ws, ids.art, ids.sol])
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) VALUES ($1,'DOC',$2)`, [ids.task, ids.doc])
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) VALUES ($1,'COMMENT',$2)`, [ids.task, ids.comment])
    // A legacy row whose target is gone: not live, so it needs no twin and must not block.
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) VALUES ($1,'DOC',$2)`, [ids.task, randomUUID()])

    // Their entity_links twins, EXCEPT the Solution -> Key Result one (added later to show the preflight refusing without it).
    await twin("OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", ids.oppPlain, "OBJECTIVE", ids.objective)
    await twin("OPPORTUNITY_TARGETS_KEY_RESULT", "OPPORTUNITY", ids.opp, "KEY_RESULT", ids.kr, "LEGACY")
    await twin("ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", ids.art, "SOLUTION", ids.sol)
    await twin("TASK_REFERENCES", "TASK", ids.task, "DOC", ids.doc)
    // An entity_links-only row (a link made after the cleanup): allowed.
    await twin("TASK_REFERENCES", "TASK", ids.task, "SOLUTION", ids.sol)
    ids.entityOnly = (await q(`SELECT id FROM $S.entity_links WHERE link_type = 'TASK_REFERENCES' AND to_type = 'SOLUTION'`)).rows[0].id
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("is explicit-only: an untargeted run names it as skipped and never applies it", async () => {
    const body = await (await run()).json()
    expect(`${body.message ?? ""}${body.log ?? ""}`).toMatch(/Skipped \(explicit-only, still pending\):[^\n]*116_entity_links_drop_legacy_tables/)
    expect(await receipt(NAME)).toBe(0)
    expect(await present()).toEqual([...LEGACY].sort())
  }, 120_000)

  it("refuses while 115 has not run, and drops nothing", async () => {
    const response = await run(NAME)
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(body.error).toMatch(/preflight refused, NOTHING was dropped/)
    expect(body.error).toMatch(/115_entity_links_task_link_move has no finished receipt/)
    expect(await present()).toEqual([...LEGACY].sort())
    expect(await hasColumn()).toBe(true)
    expect(await receipt(NAME)).toBe(0)
  }, 120_000)

  it("refuses while a live legacy row has no entity_links twin, names it, and leaves every relation and row in place", async () => {
    const moved = await run("115_entity_links_task_link_move")
    expect(moved.status, JSON.stringify(await moved.clone().json())).toBe(200)

    const before = { entityLinks: await entityLinks(), legacy: await count(`SELECT (SELECT count(*) FROM $S.solution_key_result_links) + (SELECT count(*) FROM $S.task_links) + (SELECT count(*) FROM $S.artifact_links) + (SELECT count(*) FROM $S.opportunity_objective_links) AS n`) }
    const response = await run(NAME)
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(body.error).toMatch(/preflight refused, NOTHING was dropped/)
    expect(body.error).toMatch(/parity: 1 live solutionKeyResult legacy row\(s\) have no entity_links row \(legacy ids: [0-9a-f-]{36}\)/)
    // The dangling task link, the entity_links-only row and the moved COMMENT link are not blockers.
    expect(body.error).not.toMatch(/taskReferences|taskCreatedFrom|artifactSolution|opportunity/)
    expect(await present()).toEqual([...LEGACY].sort())
    expect(await hasColumn()).toBe(true)
    expect(await receipt(NAME)).toBe(0)
    expect(await entityLinks()).toBe(before.entityLinks)
    expect(await count(`SELECT (SELECT count(*) FROM $S.solution_key_result_links) + (SELECT count(*) FROM $S.task_links) + (SELECT count(*) FROM $S.artifact_links) + (SELECT count(*) FROM $S.opportunity_objective_links) AS n`)).toBe(before.legacy)

    // The status GET reports the same verdict without writing.
    const status = (await (await getMigrationStatus(pool, schema)).json()) as StatusJson
    expect(status.entityLinksLegacyDrop).toMatchObject({ dropped: false, ready: false })
    expect(status.entityLinksLegacyDrop.blockers.join("\n")).toMatch(/solutionKeyResult/)
    expect([...status.entityLinksLegacyDrop.present].sort()).toEqual([...LEGACY, "opportunities.linked_key_result_id"].sort())
  }, 180_000)

  it("drops everything once the twin exists, records the receipt, and leaves entity_links and the surviving data untouched", async () => {
    await twin("SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", ids.sol, "KEY_RESULT", ids.kr)
    // Simulate a half-finished earlier run: one table and the column are already gone, no receipt. The rerun must resume.
    await q(`DROP TABLE $S.artifact_links`)
    await q(`ALTER TABLE $S.opportunities DROP COLUMN linked_key_result_id`)

    const links = await entityLinks()
    const opportunities = await count(`SELECT count(*)::text AS n FROM $S.opportunities`)
    const response = await run(NAME)
    const body = await response.json()
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.message).toContain("dropped table task_links")
    expect(body.message).toContain("dropped table opportunity_objective_links")
    expect(body.message).toContain("dropped table solution_key_result_links")
    expect(body.message).not.toContain("dropped table artifact_links")
    expect(body.message).toContain(`${NAME} applied`)
    expect(await present()).toEqual([])
    expect(await hasColumn()).toBe(false)
    expect(await receipt(NAME)).toBe(1)
    expect(await entityLinks()).toBe(links)
    // The entity_links-only row (no legacy twin) did not block the drop and is still there, unchanged.
    expect((await q(`SELECT from_id, to_id, link_type FROM $S.entity_links WHERE id = $1`, [ids.entityOnly])).rows).toEqual([{ from_id: ids.task, to_id: ids.sol, link_type: "TASK_REFERENCES" }])
    expect(await count(`SELECT count(*)::text AS n FROM $S.opportunities`)).toBe(opportunities)
    expect(await count(`SELECT count(*)::text AS n FROM $S.tasks`)).toBe(1)
  }, 180_000)

  it("a rerun is a no-op: already applied, and the hook itself drops nothing", async () => {
    const again = await run(NAME)
    expect(again.status).toBe(200)
    expect(await receipt(NAME)).toBe(1)
    const client = await pool.connect()
    try {
      await client.query(`SET search_path TO "${schema}"`)
      expect(await dropLegacyLinkRelations(client, schema, [])).toEqual([])
    } finally {
      client.release()
    }
  }, 120_000)

  it("the status GET never queries a dropped relation: every block reports legacyDropped, none reports an error", async () => {
    const status = (await (await getMigrationStatus(pool, schema)).json()) as StatusJson
    for (const key of ["entityLinksOpportunityBackfill", "entityLinksArtifactBackfill", "entityLinksTaskBackfill", "entityLinksTaskLinkMove", "entityLinksConversationBackfill", "entityLinksSolutionKeyResultBackfill"]) {
      expect(status[key], key).toEqual({ legacyDropped: true, missing: expect.any(Array) })
    }
    expect(status.entityLinksReadParity.error).toBeUndefined()
    expect(status.entityLinksReadParity.totalMismatches).toBe(0)
    expect(Object.values(status.entityLinksReadParity.families).every((f) => f.legacyDropped === true)).toBe(true)
    expect(status.linkIntegrity).toMatchObject({ legacyDropped: true })
    expect(status.entityLinksLegacyDrop).toMatchObject({ dropped: true, ready: true, present: [], blockers: [] })
    // #558's read-only row detail keeps working with the tables gone: every legacy source reports legacyDropped, nothing errors.
    const detail = status.entityLinksRowDetail as { error?: string; legacyOnly: { sources: Record<string, { legacyDropped?: boolean; error?: string }> } }
    expect(detail.error).toBeUndefined()
    expect(Object.keys(detail.legacyOnly.sources)).toHaveLength(4)
    expect(Object.values(detail.legacyOnly.sources).every((entry) => entry.legacyDropped === true && entry.error === undefined)).toBe(true)
    expect(status.appliedMigrations).toContain(NAME)
  }, 120_000)

  it("older explicit-only migrations still POST against the schema without the tables (their data half is skipped, the receipt is recorded)", async () => {
    for (const name of [
      "095_entity_links_backfill_opportunity", "096_entity_links_backfill_artifact", "097_entity_links_backfill_task", "098_entity_links_backfill_solution_key_result",
      "106_entity_links_residual_opportunity", "113_entity_links_backfill_conversation", "115_entity_links_task_link_move",
    ]) {
      await q(`DELETE FROM $S._prisma_migrations WHERE migration_name = $1`, [name])
      const response = await run(name)
      const body = await response.json()
      expect(response.status, `${name}: ${JSON.stringify(body)}`).toBe(200)
      expect(body.message, name).toMatch(/already dropped by 116_entity_links_drop_legacy_tables; nothing to carry over/)
      expect(await receipt(name), name).toBe(1)
    }
  }, 240_000)

  it("the surviving store still works: entity_links rows are readable and a new Opportunity row needs no pointer column", async () => {
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type = 'SOLUTION_TARGETS_KEY_RESULT'`)).toBe(1)
    await expect(q(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'after the drop') RETURNING id`, [ws])).resolves.toBeDefined()
  })
})
