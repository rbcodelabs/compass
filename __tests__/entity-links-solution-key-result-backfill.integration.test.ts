import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations, getMigrationStatus } from "@/lib/migrations/runner"
import {
  ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE,
  assertEntityLinksSolutionKeyResultBackfill,
  backfillEntityLinksSolutionKeyResult,
  getEntityLinksSolutionKeyResultStatus,
} from "@/lib/migrations/entity-links-solution-key-result-backfill"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 098 through the registered runner on a throwaway schema, with legacy rows (good and orphaned) seeded first.
 * Set ENTITY_LINKS_SOLUTION_KR_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = process.env.ENTITY_LINKS_SOLUTION_KR_DATABASE_URL
const NAME = "098_entity_links_backfill_solution_key_result"
const KEY = "SOLUTION_TARGETS_KEY_RESULT"

describe.skipIf(!databaseUrl)("098 entity_links Solution-Key Result backfill through the registered runner", () => {
  const schema = `entity_links_skr_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  let owned = false
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("$S", `"${schema}"`), params)

  const run = async (script?: string) => {
    let last = await applyMigrations(pool, schema, script)
    for (let i = 0; i < 100 && last.status === 202; i++) last = await applyMigrations(pool, schema, script)
    return last
  }
  const withClient = async <T>(work: (client: import("pg").PoolClient) => Promise<T>) => {
    const client = await pool.connect()
    try { return await work(client) } finally { client.release() }
  }

  const ws1 = randomUUID()
  const ws2 = randomUUID()
  const seeded: Record<string, string> = {}

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

    const objective = async (workspace: string | null) => (await q(`INSERT INTO $S.objectives(workspace_id,title) VALUES ($1,'o') RETURNING id`, [workspace])).rows[0].id as string
    const keyResult = async (objectiveId: string) => (await q(`INSERT INTO $S.key_results(objective_id,title,target) VALUES ($1,'kr',1) RETURNING id`, [objectiveId])).rows[0].id as string
    const opportunity = async (workspace: string) => (await q(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'op') RETURNING id`, [workspace])).rows[0].id as string
    const solution = async (workspace: string | null, opportunityId: string) =>
      (await q(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) VALUES ($1,$2,'sol') RETURNING id`, [workspace, opportunityId])).rows[0].id as string
    const link = async (workspace: string, solutionId: string, keyResultId: string, source = "UI", actor: string | null = null, createdAt = "2024-03-01 10:00:00") =>
      (await q(`INSERT INTO $S.solution_key_result_links(workspace_id,solution_id,key_result_id,source,created_by_id,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [workspace, solutionId, keyResultId, source, actor, createdAt])).rows[0].id as string

    const opp1 = await opportunity(ws1)
    const opp2 = await opportunity(ws2)
    const obj1 = await objective(ws1)
    const obj2 = await objective(ws2)
    // INTENTIONAL NULL workspaceId: an objective with no workspace is a crossWorkspace orphan that 098 must quarantine and report.
    const objNull = await objective(null)
    const kr1 = await keyResult(obj1)
    const kr1b = await keyResult(obj1)
    const kr2 = await keyResult(obj2)
    const krNull = await keyResult(objNull)
    const actor = randomUUID()

    // Good rows: one with actor/source/created_at, one plain.
    const sol1 = await solution(ws1, opp1)
    const sol1b = await solution(ws1, opp1)
    seeded.withActor = await link(ws1, sol1, kr1, "MCP", actor, "2024-03-02 11:22:33")
    seeded.plain = await link(ws1, sol1, kr1b)
    seeded.sol1 = sol1
    seeded.sol1b = sol1b
    seeded.kr1 = kr1
    seeded.kr1b = kr1b
    seeded.actor = actor

    // More than one batch of good links, to span the 500 batch cap.
    const bulk = ENTITY_LINKS_SOLUTION_KEY_RESULT_BACKFILL_BATCH_SIZE + 37
    await q(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) SELECT $1::uuid,$2::uuid,'bulk'||g FROM generate_series(1,${bulk}) g`, [ws1, opp1])
    await q(`INSERT INTO $S.solution_key_result_links(workspace_id,solution_id,key_result_id) SELECT $1::uuid, id, $2::uuid FROM $S.solutions WHERE title LIKE 'bulk%'`, [ws1, kr1])
    seeded.bulk = String(bulk)

    // Orphans: all must be quarantined, none linked, none deleted.
    seeded.crossLink = await link(ws1, sol1b, kr2) // solution in ws1, objective in ws2
    seeded.nullObjectiveLink = await link(ws1, sol1b, krNull) // objective with NULL workspace
    seeded.nullSolutionLink = await link(ws1, await solution(null, opp1), kr1) // solution with NULL workspace
    seeded.danglingKrLink = await link(ws1, sol1b, randomUUID()) // key result row gone
    seeded.danglingSolutionLink = await link(ws1, randomUUID(), kr1) // solution row gone
    seeded.driftLink = await link(ws2, await solution(ws1, opp1), kr1) // link row stamped with the wrong workspace
    seeded.ws2Solution = await solution(ws2, opp2)
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n)

  it("is explicit-only: an untargeted run names it as skipped and never applies it", async () => {
    // Other pending migrations (093 here) may stop an untargeted run on the seeded orphans; either way 098 is only ever listed as skipped.
    const untargeted = await run()
    const body = await untargeted.json()
    expect(`${body.message ?? ""}${body.log ?? ""}`).toMatch(/Skipped \(explicit-only, still pending\):[^\n]*098_entity_links_backfill_solution_key_result/)
    const applied = await q(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1`, [NAME])
    expect(applied.rows[0].n).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(0)
  }, 120_000)

  it("reports the plan before POST: unmatched and quarantined counts, no write", async () => {
    const status = await withClient((client) => getEntityLinksSolutionKeyResultStatus(client, schema))
    const bulk = Number(seeded.bulk)
    expect(status.legacyLinks).toBe(2 + bulk + 6)
    expect(status.mirroredLinks).toBe(0)
    expect(status.unmatched).toBe(2 + bulk)
    expect(status.quarantined.dangling.count).toBe(2)
    expect(status.quarantined.dangling.ids.sort()).toEqual([seeded.danglingKrLink, seeded.danglingSolutionLink].sort())
    expect(status.quarantined.crossWorkspace.count).toBe(3)
    expect(status.quarantined.linkWorkspaceDrift.count).toBe(1)
    expect(status.quarantined.linkWorkspaceDrift.ids).toEqual([seeded.driftLink])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(0)
  })

  it("GET status serves the same block (counts and capped ids, no titles) under entityLinksSolutionKeyResultBackfill", async () => {
    const body = await (await getMigrationStatus(pool, schema)).json()
    const block = body.entityLinksSolutionKeyResultBackfill
    expect(block.error).toBeUndefined()
    expect(block.legacyLinks).toBe(2 + Number(seeded.bulk) + 6)
    expect(block.quarantined.crossWorkspace.count).toBe(3)
    expect(Object.keys(block).sort()).toEqual(["legacyLinks", "mirrorRowsKeptForQuarantine", "mirroredLinks", "quarantined", "staleMirrorRows", "unmatched"])
  })

  it("old, stale and drifted mirror rows are reconciled: pruned, or workspace-repaired", async () => {
    // A stale row (no legacy counterpart) and a row for a good pair mirrored under the wrong workspace.
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'SOLUTION',$3,'KEY_RESULT',$4,'DIRECT')`, [ws1, KEY, randomUUID(), seeded.kr1])
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'SOLUTION',$3,'KEY_RESULT',$4,'DIRECT')`, [ws2, KEY, seeded.sol1, seeded.kr1b])
    const status = await withClient((client) => getEntityLinksSolutionKeyResultStatus(client, schema))
    expect(status.staleMirrorRows).toBe(1)
    expect(status.unmatched).toBe(2 + Number(seeded.bulk)) // the drifted row still counts as unmatched (wrong workspace)
  })

  it("POST 098 mirrors every consistent row exactly as the live mirror does, quarantines the orphans, and proves the postconditions", async () => {
    const result = await run(NAME)
    const body = await result.json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(body.message).toContain("quarantined")
    expect(body.message).toContain(seeded.crossLink)
    expect(body.message).toContain(seeded.danglingKrLink)
    expect(body.message).toContain(seeded.driftLink)
    const bulk = Number(seeded.bulk)

    // Every consistent legacy link, with origin DIRECT, the Solution's workspace, and source, actor and created_at copied.
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [KEY])).toBe(2 + bulk)
    const withActor = (await q(`SELECT e.from_type, e.to_type, e.origin, e.source, e.created_by_id, e.created_at::text AS created_at, e.workspace_id FROM $S.entity_links e WHERE e.link_type=$1 AND e.from_id=$2 AND e.to_id=$3`, [KEY, seeded.sol1, seeded.kr1])).rows
    expect(withActor).toEqual([{ from_type: "SOLUTION", to_type: "KEY_RESULT", origin: "DIRECT", source: "MCP", created_by_id: seeded.actor, created_at: "2024-03-02 11:22:33", workspace_id: ws1 }])
    // The row that was mirrored under the wrong workspace was repaired, not duplicated; the stale row was pruned.
    expect((await q(`SELECT workspace_id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, seeded.sol1, seeded.kr1b])).rows).toEqual([{ workspace_id: ws1 }])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND to_id=$2 AND from_id NOT IN (SELECT id FROM $S.solutions)`, [KEY, seeded.kr1])).toBe(0)

    // Orphans: never linked...
    for (const orphan of [seeded.crossLink, seeded.nullObjectiveLink, seeded.nullSolutionLink, seeded.danglingKrLink, seeded.danglingSolutionLink, seeded.driftLink]) {
      const row = (await q(`SELECT solution_id, key_result_id FROM $S.solution_key_result_links WHERE id=$1`, [orphan])).rows[0]
      expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, row.solution_id, row.key_result_id])).toBe(0)
    }
    // ...and never deleted: every legacy row is still there.
    expect(await count(`SELECT count(*)::text AS n FROM $S.solution_key_result_links`)).toBe(2 + bulk + 6)

    // Postconditions hold on the real tables, and the receipt is recorded.
    await withClient((client) => assertEntityLinksSolutionKeyResultBackfill(client, schema))
    const receipt = await q(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [NAME])
    expect(receipt.rows[0].n).toBe(1)
    const status = await withClient((client) => getEntityLinksSolutionKeyResultStatus(client, schema))
    expect({ unmatched: status.unmatched, staleMirrorRows: status.staleMirrorRows, mirroredLinks: status.mirroredLinks }).toEqual({ unmatched: 0, staleMirrorRows: 0, mirroredLinks: 2 + bulk })
  }, 240_000)

  it("a re-run of the hook is idempotent: nothing inserted, repaired or pruned, same counts and quarantine", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links`)
    const again = await withClient((client) => backfillEntityLinksSolutionKeyResult(client, schema, []))
    expect({ pruned: again.pruned, repaired: again.repaired, inserted: again.inserted }).toEqual({ pruned: 0, repaired: 0, inserted: 0 })
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
    expect(again.quarantined.dangling.count).toBe(2)
    // The runner treats the receipted migration as applied, so a second POST is a no-op too.
    const second = await run(NAME)
    expect(second.status).toBe(200)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
  }, 240_000)

  it("a resumed run repairs drift introduced after the receipt (a deleted legacy row, a new unmirrored link) and still passes", async () => {
    await q(`DELETE FROM $S.solution_key_result_links WHERE id=$1`, [seeded.withActor])
    const added = await q(`INSERT INTO $S.solution_key_result_links(workspace_id,solution_id,key_result_id,source) VALUES ($1,$2,$3,'API') RETURNING id`, [ws1, seeded.sol1b, seeded.kr1])
    expect(added.rows).toHaveLength(1)
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksSolutionKeyResult(client, schema, [])
      await assertEntityLinksSolutionKeyResultBackfill(client, schema)
      return done
    })
    expect({ pruned: result.pruned, inserted: result.inserted }).toEqual({ pruned: 1, inserted: 1 })
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, seeded.sol1, seeded.kr1])).toBe(0)
    expect((await q(`SELECT source, workspace_id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, seeded.sol1b, seeded.kr1])).rows).toEqual([{ source: "API", workspace_id: ws1 }])
  }, 240_000)

  it("refuses the receipt when a workspace-mismatched mirror row survives (postconditions fail closed), and a re-run repairs it", async () => {
    const victim = (await q(`SELECT id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [KEY])).rows[0].id
    await q(`UPDATE $S.entity_links SET workspace_id=$2 WHERE id=$1`, [victim, ws2])
    await expect(withClient((client) => assertEntityLinksSolutionKeyResultBackfill(client, schema))).rejects.toThrow(/postcondition failed/)
    await withClient((client) => backfillEntityLinksSolutionKeyResult(client, schema, []))
    await withClient((client) => assertEntityLinksSolutionKeyResultBackfill(client, schema))
  }, 120_000)

  it("a duplicate pair is refused by the postconditions", async () => {
    // The unique pair index normally forbids duplicates; drop it on this throwaway schema to prove the assertion alone would refuse.
    const index = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND tablename='entity_links' AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%from_id%' AND indexdef ILIKE '%to_id%'`, [schema])).rows[0]?.indexname as string | undefined
    expect(index, "the unique pair index exists on entity_links").toBeDefined()
    await q(`DROP INDEX $S."${index!}"`)
    const row = (await q(`SELECT workspace_id, from_id, to_id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [KEY])).rows[0]
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'SOLUTION',$3,'KEY_RESULT',$4,'DIRECT')`, [row.workspace_id, KEY, row.from_id, row.to_id])
    await expect(withClient((client) => assertEntityLinksSolutionKeyResultBackfill(client, schema))).rejects.toThrow(/uniqueness postcondition failed/)
    await q(`DELETE FROM $S.entity_links WHERE id = (SELECT id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3 LIMIT 1)`, [KEY, row.from_id, row.to_id])
  }, 120_000)

  it.each([
    ["linkWorkspaceDrift", "legacy link stamped with another workspace", (id: string) => q(`UPDATE $S.solution_key_result_links SET workspace_id=$2 WHERE id=$1`, [id, ws2]), (id: string) => q(`UPDATE $S.solution_key_result_links SET workspace_id=$2 WHERE id=$1`, [id, ws1])],
    ["crossWorkspace", "key result moved under an objective of another workspace", (_id: string) => q(`UPDATE $S.key_results SET objective_id=(SELECT id FROM $S.objectives WHERE workspace_id=$2 LIMIT 1) WHERE id=$1`, [seeded.kr1b, ws2]), (_id: string) => q(`UPDATE $S.key_results SET objective_id=(SELECT id FROM $S.objectives WHERE workspace_id=$2 LIMIT 1) WHERE id=$1`, [seeded.kr1b, ws1])],
  ])("%s: the mirror row of a pair that became %s is kept unchanged and reported, never deleted or repaired, and the postconditions pass", async (cls, _what, break_, restore) => {
    const pair = [seeded.sol1, seeded.kr1b]
    const legacyId = (await q(`SELECT id FROM $S.solution_key_result_links WHERE solution_id=$1 AND key_result_id=$2`, pair)).rows[0].id as string
    const mirrorBefore = (await q(`SELECT id, workspace_id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, ...pair])).rows
    expect(mirrorBefore).toHaveLength(1)
    await break_(legacyId)
    const log: string[] = []
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksSolutionKeyResult(client, schema, log)
      await assertEntityLinksSolutionKeyResultBackfill(client, schema)
      return done
    })
    expect(result.pruned).toBe(0)
    expect(result.repaired).toBe(0)
    expect((await q(`SELECT id, workspace_id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, ...pair])).rows).toEqual(mirrorBefore)
    expect(result.keptMirrorRows.ids).toContain(mirrorBefore[0].id)
    expect(result.quarantined[cls as "crossWorkspace" | "linkWorkspaceDrift"].ids).toContain(legacyId)
    expect(await count(`SELECT count(*)::text AS n FROM $S.solution_key_result_links WHERE id=$1`, [legacyId])).toBe(1)
    await restore(legacyId)
    await withClient((client) => backfillEntityLinksSolutionKeyResult(client, schema, []))
    await withClient((client) => assertEntityLinksSolutionKeyResultBackfill(client, schema))
  }, 120_000)

  it("mirror rows whose legacy row became quarantined are kept and reported, never deleted, and the postconditions still pass", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [KEY])
    expect(before).toBeGreaterThan(0)
    await q(`DELETE FROM $S.objectives WHERE id=(SELECT objective_id FROM $S.key_results WHERE id=$1)`, [seeded.kr1])
    const log: string[] = []
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksSolutionKeyResult(client, schema, log)
      await assertEntityLinksSolutionKeyResultBackfill(client, schema)
      return done
    })
    expect(result.pruned).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [KEY])).toBe(before)
    expect(result.keptMirrorRows.count).toBeGreaterThan(0)
    expect(result.keptMirrorRows.ids).toHaveLength(50)
    expect(log.join("\n")).toContain("mirror row(s) whose legacy row is quarantined, not deleted")
    const status = await withClient((client) => getEntityLinksSolutionKeyResultStatus(client, schema))
    expect(status.mirrorRowsKeptForQuarantine.count).toBe(result.keptMirrorRows.count)
  }, 120_000)
})
