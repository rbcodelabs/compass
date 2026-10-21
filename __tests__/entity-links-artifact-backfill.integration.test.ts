import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import {
  ENTITY_LINKS_ARTIFACT_BACKFILL_BATCH_SIZE,
  assertEntityLinksArtifactBackfill,
  backfillEntityLinksArtifact,
  getEntityLinksArtifactStatus,
} from "@/lib/migrations/entity-links-artifact-backfill"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 096 through the registered runner on a throwaway schema, with legacy rows (good and orphaned) seeded first.
 * Set ENTITY_LINKS_ARTIFACT_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = process.env.ENTITY_LINKS_ARTIFACT_DATABASE_URL
const NAME = "096_entity_links_backfill_artifact"
const SOL = "ARTIFACT_ATTACHED_TO_SOLUTION"
const DEC = "ARTIFACT_SUPPORTS_DECISION"

describe.skipIf(!databaseUrl)("096 entity_links artifact backfill through the registered runner", () => {
  const schema = `entity_links_art_test_${randomUUID().replaceAll("-", "")}`
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

    const artifact = async (workspace: string, title = "art") =>
      (await q(`INSERT INTO $S.artifacts(workspace_id,title,source_type) VALUES ($1,$2,'EXTERNAL_LINK') RETURNING id`, [workspace, title])).rows[0].id as string
    const opportunity = async (workspace: string) => (await q(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'op') RETURNING id`, [workspace])).rows[0].id as string
    // INTENTIONAL NULL workspaceId allowed for solutions (an unbackfilled row): a crossWorkspace orphan that 096 must quarantine.
    const solution = async (workspace: string | null) =>
      (await q(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) VALUES ($1,$2,'sol') RETURNING id`, [workspace, await opportunity(workspace ?? ws1)])).rows[0].id as string
    const request = async (workspace: string, gate: string) =>
      (await q(`INSERT INTO $S.review_requests(workspace_id,gate_type,subject_type,subject_id) VALUES ($1,$2,'DOC',$3) RETURNING id`, [workspace, gate, randomUUID()])).rows[0].id as string
    const link = async (workspace: string, artifactId: string, type: string, linkedId: string, source = "UI", actor: string | null = null, createdAt = "2024-03-01 10:00:00") =>
      (await q(`INSERT INTO $S.artifact_links(workspace_id,artifact_id,linked_type,linked_id,source,created_by_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [workspace, artifactId, type, linkedId, source, actor, createdAt])).rows[0].id as string

    const art1 = await artifact(ws1)
    const art2 = await artifact(ws2)
    const sol1 = await solution(ws1)
    const sol2 = await solution(ws2)
    const solNull = await solution(null)
    const req1 = await request(ws1, "TRACKED_DECISION")
    const reqSystem = await request(ws1, "PRODUCT_LAUNCH")
    const req2 = await request(ws2, "TRACKED_DECISION")
    const actor = randomUUID()
    seeded.actor = actor
    seeded.art1 = art1
    seeded.sol1 = sol1
    seeded.req1 = req1

    // Good rows with their source, actor and created_at.
    seeded.solLink = await link(ws1, art1, "SOLUTION", sol1, "MCP", actor, "2024-03-02 11:22:33")
    seeded.decLink = await link(ws1, art1, "REVIEW_REQUEST", req1, "UI", actor, "2024-03-03 01:02:03")

    // More than one batch of good links of each type, to span the 500 batch cap.
    const bulk = ENTITY_LINKS_ARTIFACT_BACKFILL_BATCH_SIZE + 37
    await q(`INSERT INTO $S.artifacts(workspace_id,title,source_type) SELECT $1::uuid,'bulk'||g,'EXTERNAL_LINK' FROM generate_series(1,${bulk}) g`, [ws1])
    await q(`INSERT INTO $S.artifact_links(workspace_id,artifact_id,linked_type,linked_id) SELECT $1::uuid, id, 'SOLUTION', $2::uuid FROM $S.artifacts WHERE title LIKE 'bulk%'`, [ws1, sol1])
    await q(`INSERT INTO $S.artifact_links(workspace_id,artifact_id,linked_type,linked_id) SELECT $1::uuid, id, 'REVIEW_REQUEST', $2::uuid FROM $S.artifacts WHERE title LIKE 'bulk%'`, [ws1, req1])
    seeded.bulk = String(bulk)

    // Orphans: every class. All must be quarantined, none linked, none deleted.
    seeded.invalidType = await link(ws1, art1, "EXPERIMENT", randomUUID())
    seeded.danglingArtifact = await link(ws1, randomUUID(), "SOLUTION", sol1)
    seeded.danglingSolution = await link(ws1, art1, "SOLUTION", randomUUID())
    seeded.danglingRequest = await link(ws1, art1, "REVIEW_REQUEST", randomUUID())
    seeded.crossSolution = await link(ws1, art1, "SOLUTION", sol2) // artifact in ws1, solution in ws2
    seeded.crossArtifact = await link(ws1, art2, "REVIEW_REQUEST", req1) // artifact in ws2, request in ws1
    seeded.nullSolution = await link(ws1, art1, "SOLUTION", solNull) // solution with no workspace
    seeded.drift = await link(ws2, await artifact(ws1), "SOLUTION", sol1) // link row stamped with the wrong workspace
    seeded.notTracked = await link(ws1, art1, "REVIEW_REQUEST", reqSystem) // not a TRACKED_DECISION
    seeded.crossRequest = await link(ws2, art1, "REVIEW_REQUEST", req2) // artifact in ws1, request in ws2
    seeded.otherWorkspaceGood = await link(ws2, art2, "SOLUTION", sol2) // a good row in the other tenant
    seeded.req2 = req2
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n)
  const ORPHANS = () => [seeded.invalidType, seeded.danglingArtifact, seeded.danglingSolution, seeded.danglingRequest, seeded.crossSolution, seeded.crossArtifact, seeded.nullSolution, seeded.drift, seeded.notTracked, seeded.crossRequest]

  it("is explicit-only: an untargeted run names it as skipped and never applies it", async () => {
    const untargeted = await run()
    const body = await untargeted.json()
    expect(`${body.message ?? ""}${body.log ?? ""}`).toMatch(/Skipped \(explicit-only, still pending\):[^\n]*096_entity_links_backfill_artifact/)
    const applied = await q(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1`, [NAME])
    expect(applied.rows[0].n).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(0)
  }, 120_000)

  it("reports the plan before POST: unmatched and quarantined counts by class, no write", async () => {
    const status = await withClient((client) => getEntityLinksArtifactStatus(client, schema))
    const bulk = Number(seeded.bulk)
    expect(status.legacyLinks).toBe(2 + 2 * bulk + 11)
    expect(status.mirroredSolutionLinks + status.mirroredDecisionLinks).toBe(0)
    expect(status.unmatched).toBe(2 + 2 * bulk + 1)
    expect(status.quarantined.invalidType.count).toBe(1)
    expect(status.quarantined.dangling.count).toBe(3)
    expect(status.quarantined.crossWorkspace.count).toBe(4)
    expect(status.quarantined.linkWorkspaceDrift.count).toBe(1)
    expect(status.quarantined.notTrackedDecision.count).toBe(1)
    expect(status.quarantined.invalidType.ids).toEqual([seeded.invalidType])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(0)
  })

  it("old, stale and drifted mirror rows are reconciled: pruned, or repaired, or left for the legacy truth", async () => {
    // A stale solution row (no legacy counterpart), a stale decision row, and a good pair (a bulk artifact -> sol1) mirrored with the wrong workspace and origin.
    seeded.bulk1 = (await q(`SELECT id FROM $S.artifacts WHERE title='bulk1'`)).rows[0].id
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id) VALUES ($1,$2,'ARTIFACT',$3,'SOLUTION',$4)`, [ws1, SOL, randomUUID(), seeded.sol1])
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id) VALUES ($1,$2,'ARTIFACT',$3,'REVIEW_REQUEST',$4)`, [ws1, DEC, seeded.art1, randomUUID()])
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'ARTIFACT',$3,'SOLUTION',$4,'LEGACY')`, [ws2, SOL, seeded.bulk1, seeded.sol1])
    const status = await withClient((client) => getEntityLinksArtifactStatus(client, schema))
    expect(status.staleMirrorRows).toBe(2)
  })

  it("POST 096 mirrors every consistent row with source, actor and created_at copied, quarantines every orphan class, and proves the postconditions", async () => {
    const result = await run(NAME)
    const body = await result.json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(body.message).toContain("quarantined")
    for (const id of [seeded.invalidType, seeded.danglingSolution, seeded.crossSolution, seeded.drift, seeded.notTracked]) expect(body.message).toContain(id)
    const bulk = Number(seeded.bulk)

    // Every consistent legacy link: 1 + bulk solutions in ws1 + the other tenant's good row; 1 + bulk decisions.
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [SOL])).toBe(1 + bulk + 1)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [DEC])).toBe(1 + bulk)
    const sol = (await q(`SELECT origin, source, created_by_id, created_at::text AS created_at, workspace_id, from_type, to_type FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [SOL, seeded.art1, seeded.sol1])).rows
    expect(sol).toEqual([{ origin: "DIRECT", source: "MCP", created_by_id: seeded.actor, created_at: "2024-03-02 11:22:33", workspace_id: ws1, from_type: "ARTIFACT", to_type: "SOLUTION" }])
    const dec = (await q(`SELECT origin, source, created_by_id, created_at::text AS created_at, workspace_id, to_type FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [DEC, seeded.art1, seeded.req1])).rows
    expect(dec).toEqual([{ origin: "DIRECT", source: "UI", created_by_id: seeded.actor, created_at: "2024-03-03 01:02:03", workspace_id: ws1, to_type: "REVIEW_REQUEST" }])
    // The stale rows are gone; the drifted pair was repaired in place (one row, right workspace and origin).
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3 AND workspace_id=$4 AND origin='DIRECT'`, [SOL, seeded.bulk1, seeded.sol1, ws1])).toBe(1)

    // Orphans: never linked (no mirror row for any of their pairs)...
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links e JOIN $S.artifact_links l ON e.from_id=l.artifact_id AND e.to_id=l.linked_id WHERE l.id = ANY($1::uuid[])`, [ORPHANS()])).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE to_id IN ($1,$2)`, [seeded.sol1, seeded.req1])).toBe(2 + 2 * bulk)
    // ...and never deleted or touched: every legacy row is still there.
    expect(await count(`SELECT count(*)::text AS n FROM $S.artifact_links`)).toBe(2 + 2 * bulk + 11)
    for (const id of ORPHANS()) expect(await count(`SELECT count(*)::text AS n FROM $S.artifact_links WHERE id=$1`, [id])).toBe(1)

    await withClient((client) => assertEntityLinksArtifactBackfill(client, schema))
    const receipt = await q(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [NAME])
    expect(receipt.rows[0].n).toBe(1)
  }, 240_000)

  it("a re-run of the hook is idempotent: nothing inserted, repaired or pruned, same counts and quarantine", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links`)
    const again = await withClient((client) => backfillEntityLinksArtifact(client, schema, []))
    expect({ pruned: again.pruned, repaired: again.repaired, inserted: again.inserted }).toEqual({ pruned: 0, repaired: 0, inserted: 0 })
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
    expect(again.quarantined.dangling.count).toBe(3)
    // The runner treats the receipted migration as applied, so a second POST is a no-op too.
    const second = await run(NAME)
    expect(second.status).toBe(200)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
  }, 240_000)

  it("a resumed run prunes mirror rows whose legacy row went and still passes", async () => {
    await q(`DELETE FROM $S.artifact_links WHERE id=$1`, [seeded.solLink])
    await q(`DELETE FROM $S.artifact_links WHERE id=$1`, [seeded.decLink])
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksArtifact(client, schema, [])
      await assertEntityLinksArtifactBackfill(client, schema)
      return done
    })
    expect(result.pruned).toBe(2)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE from_id=$1 AND to_id IN ($2,$3)`, [seeded.art1, seeded.sol1, seeded.req1])).toBe(0)
  }, 120_000)

  it("refuses the receipt when a workspace-mismatched mirror row survives (postconditions fail closed), and the hook repairs it", async () => {
    const victim = (await q(`SELECT id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [SOL])).rows[0].id
    await q(`UPDATE $S.entity_links SET workspace_id=$2 WHERE id=$1`, [victim, randomUUID()])
    await expect(withClient((client) => assertEntityLinksArtifactBackfill(client, schema))).rejects.toThrow(/postcondition failed/)
    await withClient((client) => backfillEntityLinksArtifact(client, schema, []))
    await withClient((client) => assertEntityLinksArtifactBackfill(client, schema))
  }, 120_000)

  it("mirror rows whose legacy row became quarantined are kept and reported, never deleted, and the postconditions still pass", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type IN ($1,$2)`, [SOL, DEC])
    expect(before).toBeGreaterThan(0)
    await q(`DELETE FROM $S.solutions WHERE id=$1`, [seeded.sol1])
    const log: string[] = []
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksArtifact(client, schema, log)
      await assertEntityLinksArtifactBackfill(client, schema)
      return done
    })
    expect(result.pruned).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type IN ($1,$2)`, [SOL, DEC])).toBe(before)
    expect(result.keptMirrorRows.count).toBeGreaterThan(0)
    expect(result.keptMirrorRows.ids).toHaveLength(50)
    expect(log.join("\n")).toContain("mirror row(s) whose legacy row is quarantined, not deleted")
    const status = await withClient((client) => getEntityLinksArtifactStatus(client, schema))
    expect(status.mirrorRowsKeptForQuarantine.count).toBe(result.keptMirrorRows.count)
  }, 120_000)
})
