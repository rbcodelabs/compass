import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import {
  ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE,
  assertEntityLinksOpportunityBackfill,
  backfillEntityLinksOpportunity,
  getEntityLinksOpportunityStatus,
} from "@/lib/migrations/entity-links-opportunity-backfill"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 095 through the registered runner on a throwaway schema, with legacy rows (good and orphaned) seeded first.
 * Set ENTITY_LINKS_OPPORTUNITY_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = process.env.ENTITY_LINKS_OPPORTUNITY_DATABASE_URL
const NAME = "095_entity_links_backfill_opportunity"
const OBJ = "OPPORTUNITY_TARGETS_OBJECTIVE"
const KR = "OPPORTUNITY_TARGETS_KEY_RESULT"

describe.skipIf(!databaseUrl)("095 entity_links opportunity backfill through the registered runner", () => {
  const schema = `entity_links_opp_test_${randomUUID().replaceAll("-", "")}`
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
  const ids = { good: [] as string[] }
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
    const opportunity = async (workspace: string, pointer: string | null = null) =>
      (await q(`INSERT INTO $S.opportunities(workspace_id,title,linked_key_result_id) VALUES ($1,'op',$2) RETURNING id`, [workspace, pointer])).rows[0].id as string
    const link = async (workspace: string, opportunityId: string, objectiveId: string, origin: string, source = "UI", actor: string | null = null, createdAt = "2024-03-01 10:00:00") =>
      (await q(`INSERT INTO $S.opportunity_objective_links(workspace_id,opportunity_id,objective_id,origin,source,created_by_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [workspace, opportunityId, objectiveId, origin, source, actor, createdAt])).rows[0].id as string

    const obj1 = await objective(ws1)
    const obj2 = await objective(ws2)
    // INTENTIONAL NULL workspaceId: an objective with no workspace is a crossWorkspace orphan that 095 must quarantine and report.
    const objNull = await objective(null)
    const kr1 = await keyResult(obj1)
    const kr2 = await keyResult(obj2)
    const krNull = await keyResult(objNull)
    const actor = randomUUID()

    // Good rows: one DIRECT with actor/source/created_at, one LEGACY.
    const oppDirect = await opportunity(ws1)
    const oppLegacy = await opportunity(ws1, kr1)
    seeded.direct = await link(ws1, oppDirect, obj1, "DIRECT", "MCP", actor, "2024-03-02 11:22:33")
    seeded.legacy = await link(ws1, oppLegacy, obj1, "LEGACY", "MIGRATION")
    seeded.oppDirect = oppDirect
    seeded.oppLegacy = oppLegacy
    seeded.actor = actor
    seeded.obj1 = obj1
    seeded.kr1 = kr1

    // More than one batch of good pointers and links, to span the 500 batch cap.
    const bulk = ENTITY_LINKS_OPPORTUNITY_BACKFILL_BATCH_SIZE + 37
    await q(`INSERT INTO $S.opportunities(workspace_id,title,linked_key_result_id) SELECT $1::uuid,'bulk'||g,$2::uuid FROM generate_series(1,${bulk}) g`, [ws1, kr1])
    await q(`INSERT INTO $S.opportunities(workspace_id,title) SELECT $1::uuid,'bulklink'||g FROM generate_series(1,${bulk}) g`, [ws1])
    await q(`INSERT INTO $S.opportunity_objective_links(workspace_id,opportunity_id,objective_id,origin) SELECT $1::uuid, id, $2::uuid, 'DIRECT' FROM $S.opportunities WHERE title LIKE 'bulklink%'`, [ws1, obj1])
    seeded.bulk = String(bulk)

    // Orphans: all must be quarantined, none linked, none deleted.
    const oppX = await opportunity(ws1)
    seeded.crossLink = await link(ws1, oppX, obj2, "DIRECT") // opportunity in ws1, objective in ws2
    seeded.nullLink = await link(ws1, oppX, objNull, "DIRECT") // objective with NULL workspace
    seeded.danglingObjectiveLink = await link(ws1, oppX, randomUUID(), "DIRECT") // objective row gone
    seeded.danglingOpportunityLink = await link(ws1, randomUUID(), obj1, "DIRECT") // opportunity row gone
    seeded.driftLink = await link(ws2, await opportunity(ws1), obj1, "LEGACY") // link row stamped with the wrong workspace
    seeded.badOriginLink = await link(ws1, await opportunity(ws1), obj1, "WEIRD")
    seeded.crossPointer = await opportunity(ws1, kr2)
    seeded.nullPointer = await opportunity(ws1, krNull)
    seeded.danglingPointer = await opportunity(ws1, randomUUID())
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n)

  it("is explicit-only: an untargeted run names it as skipped and never applies it", async () => {
    // Other pending migrations (093 here) may stop an untargeted run on the seeded orphans; either way 095 is only ever listed as skipped.
    const untargeted = await run()
    const body = await untargeted.json()
    expect(`${body.message ?? ""}${body.log ?? ""}`).toMatch(/Skipped \(explicit-only, still pending\):[^\n]*095_entity_links_backfill_opportunity/)
    const applied = await q(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1`, [NAME])
    expect(applied.rows[0].n).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(0)
  }, 120_000)

  it("reports the plan before POST: unmatched and quarantined counts, no write", async () => {
    const status = await withClient((client) => getEntityLinksOpportunityStatus(client, schema))
    const bulk = Number(seeded.bulk)
    expect(status.legacyObjectiveLinks).toBe(2 + bulk + 6)
    expect(status.mirroredObjectiveLinks).toBe(0)
    expect(status.unmatched.objectiveLinks).toBe(2 + bulk)
    expect(status.unmatched.keyResultPointers).toBe(1 + bulk)
    expect(status.quarantined.objectiveLinks.dangling.count).toBe(2)
    expect(status.quarantined.objectiveLinks.crossWorkspace.count).toBe(2)
    expect(status.quarantined.objectiveLinks.linkWorkspaceDrift.count).toBe(1)
    expect(status.quarantined.objectiveLinks.invalidOrigin.count).toBe(1)
    expect(status.quarantined.keyResultPointers.crossWorkspace.count).toBe(2)
    expect(status.quarantined.keyResultPointers.dangling.count).toBe(1)
    expect(status.quarantined.keyResultPointers.dangling.ids).toEqual([seeded.danglingPointer])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(0)
  })

  it("old, stale and drifted mirror rows are reconciled: pruned, origin-repaired, or left for the legacy truth", async () => {
    // A stale objective row (no legacy counterpart), a stale pointer row (the opportunity points elsewhere) and a DIRECT row mirrored with the wrong origin.
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'OPPORTUNITY',$3,'OBJECTIVE',$4,'DIRECT')`, [ws1, OBJ, randomUUID(), seeded.obj1])
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'OPPORTUNITY',$3,'KEY_RESULT',$4,'LEGACY')`, [ws1, KR, seeded.oppLegacy, randomUUID()])
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'OPPORTUNITY',$3,'OBJECTIVE',$4,'DIRECT')`, [ws1, OBJ, seeded.oppLegacy, seeded.obj1])
    const status = await withClient((client) => getEntityLinksOpportunityStatus(client, schema))
    expect(status.staleMirrorRows).toEqual({ objectiveLinks: 1, keyResultPointers: 1 })
  })

  it("POST 095 mirrors every consistent row with origin preserved, quarantines the orphans, and proves the postconditions", async () => {
    const result = await run(NAME)
    const body = await result.json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(body.message).toContain("quarantined")
    expect(body.message).toContain(seeded.danglingPointer)
    expect(body.message).toContain(seeded.crossLink)
    const bulk = Number(seeded.bulk)

    // OPPORTUNITY_TARGETS_OBJECTIVE: every consistent legacy link, with its origin, source, actor and created_at copied.
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [OBJ])).toBe(2 + bulk)
    const direct = (await q(`SELECT e.origin, e.source, e.created_by_id, e.created_at::text AS created_at, e.workspace_id FROM $S.entity_links e WHERE e.link_type=$1 AND e.from_id=$2 AND e.to_id=$3`, [OBJ, seeded.oppDirect, seeded.obj1])).rows
    expect(direct).toEqual([{ origin: "DIRECT", source: "MCP", created_by_id: seeded.actor, created_at: "2024-03-02 11:22:33", workspace_id: ws1 }])
    expect((await q(`SELECT origin FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [OBJ, seeded.oppLegacy])).rows).toEqual([{ origin: "LEGACY" }])

    // OPPORTUNITY_TARGETS_KEY_RESULT: one per consistent pointer, origin LEGACY, and the stale pointer row is gone.
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [KR])).toBe(1 + bulk)
    expect((await q(`SELECT to_id, origin, source FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [KR, seeded.oppLegacy])).rows).toEqual([{ to_id: seeded.kr1, origin: "LEGACY", source: "MIGRATION" }])

    // Orphans: never linked...
    for (const orphan of [seeded.crossPointer, seeded.nullPointer, seeded.danglingPointer]) {
      expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE from_id=$1`, [orphan])).toBe(0)
    }
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND to_id <> $2 AND to_type='OBJECTIVE'`, [OBJ, seeded.obj1])).toBe(0)
    // ...and never deleted or touched: every legacy row and pointer is still there.
    expect(await count(`SELECT count(*)::text AS n FROM $S.opportunity_objective_links`)).toBe(2 + bulk + 6)
    for (const id of [seeded.crossLink, seeded.nullLink, seeded.danglingObjectiveLink, seeded.danglingOpportunityLink, seeded.driftLink, seeded.badOriginLink]) {
      expect(await count(`SELECT count(*)::text AS n FROM $S.opportunity_objective_links WHERE id=$1`, [id])).toBe(1)
    }
    expect(await count(`SELECT count(*)::text AS n FROM $S.opportunities WHERE linked_key_result_id IS NOT NULL`)).toBe(1 + bulk + 3)

    // Postconditions hold on the real tables.
    await withClient((client) => assertEntityLinksOpportunityBackfill(client, schema))
    const receipt = await q(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [NAME])
    expect(receipt.rows[0].n).toBe(1)
  }, 240_000)

  it("a re-run of the hook is idempotent: nothing inserted, repaired or pruned, same counts and quarantine", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links`)
    const log: string[] = []
    const again = await withClient((client) => backfillEntityLinksOpportunity(client, schema, log))
    expect({ pruned: again.pruned, repaired: again.repaired, inserted: again.inserted }).toEqual({ pruned: 0, repaired: 0, inserted: 0 })
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
    expect(again.quarantined.objectiveLinks.dangling.count).toBe(2)
    // The runner treats the receipted migration as applied, so a second POST is a no-op too.
    const second = await run(NAME)
    expect(second.status).toBe(200)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
  }, 240_000)

  it("a resumed run repairs drift introduced after the receipt (a flipped origin, a moved pointer, a deleted legacy row) and still passes", async () => {
    await q(`UPDATE $S.opportunity_objective_links SET origin='DIRECT' WHERE id=$1`, [seeded.legacy])
    await q(`DELETE FROM $S.opportunity_objective_links WHERE id=$1`, [seeded.direct])
    await q(`UPDATE $S.opportunities SET linked_key_result_id=NULL WHERE id=$1`, [seeded.oppLegacy])
    const log: string[] = []
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksOpportunity(client, schema, log)
      await assertEntityLinksOpportunityBackfill(client, schema)
      return done
    })
    expect(result.repaired).toBe(1)
    expect(result.pruned).toBe(2)
    expect((await q(`SELECT origin FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [OBJ, seeded.oppLegacy])).rows).toEqual([{ origin: "DIRECT" }])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [KR, seeded.oppLegacy])).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE from_id=$1`, [seeded.oppDirect])).toBe(0)
  }, 240_000)

  it("refuses the receipt when a duplicate or workspace-mismatched mirror row survives (postconditions fail closed)", async () => {
    // A mirror row whose workspace_id disagrees with its (consistent) endpoints, on a pair whose legacy row is consistent: repair fixes it,
    // so the postcondition passes; with the repair bypassed the assertion alone must refuse.
    const victim = (await q(`SELECT id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [OBJ])).rows[0].id
    await q(`UPDATE $S.entity_links SET workspace_id=$2 WHERE id=$1`, [victim, ws2])
    await expect(withClient((client) => assertEntityLinksOpportunityBackfill(client, schema))).rejects.toThrow(/postcondition failed/)
    await withClient((client) => backfillEntityLinksOpportunity(client, schema, []))
    await withClient((client) => assertEntityLinksOpportunityBackfill(client, schema))
  }, 120_000)
})
