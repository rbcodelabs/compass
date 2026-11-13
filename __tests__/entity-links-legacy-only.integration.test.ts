import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getMigrationStatus } from "@/lib/migrations/runner"
import { LEGACY_SOURCES, ROW_DETAIL_CAP, getEntityLinksRowDetailStatus, type LegacyOnlyRow, type LegacyOnlySourceStatus, type LegacyOnlyStatus } from "@/lib/migrations/entity-links-row-detail"
import { getEntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * The legacy-only part of entityLinksRowDetail against a real Postgres: legacy rows with no entity_links twin, for the four legacy tables
 * and the opportunities.linked_key_result_id pointer, on throwaway schemas built by replaying every migration.
 * Set INTEGRATION_TEST_DATABASE_URL to the local compass_e2e database (Postgres 16) to enable.
 */
const databaseUrl = integrationDatabaseUrl

/** Which parity families make up each legacy source (the same families the status itself uses). */
const FAMILIES: Record<(typeof LEGACY_SOURCES)[number], string[]> = {
  artifact_links: ["artifactSolution", "artifactDecision"],
  solution_key_result_links: ["solutionKeyResult"],
  opportunity_objective_links: ["opportunityObjective"],
  task_links: ["taskReferences", "taskCreatedFrom"],
  "opportunities.linked_key_result_id": ["opportunityKeyResultPointer"],
}

describe.skipIf(!databaseUrl)("entityLinksRowDetail legacy-only rows on a real Postgres", () => {
  const stamp = randomUUID().replaceAll("-", "")
  const schema = `legacy_only_test_${stamp}`
  const absentSchema = `legacy_absent_test_${stamp}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  const owned: string[] = []
  const q = (sql: string, params: unknown[] = [], target = schema) => pool.query(sql.replaceAll("$S", `"${target}"`), params)
  const withClient = async <T>(work: (client: import("pg").PoolClient) => Promise<T>) => {
    const client = await pool.connect()
    try { return await work(client) } finally { client.release() }
  }
  const detail = (target = schema) => withClient(async (client) => getEntityLinksRowDetailStatus(client, target, await getEntityLinksReadParityStatus(client, target)))
  const sourcesOf = (legacyOnly: LegacyOnlyStatus | { error: string }) => {
    if ("error" in legacyOnly) throw new Error(legacyOnly.error)
    return legacyOnly.sources
  }
  const ok = (status: LegacyOnlySourceStatus) => {
    if ("error" in status) throw new Error(status.error)
    return status
  }

  const ws1 = randomUUID()
  const ws2 = randomUUID()
  const actor = randomUUID()
  const ids: Record<string, string> = {}

  const opp = async (workspace: string, pointer: string | null = null) => (await q(`INSERT INTO $S.opportunities(workspace_id,title,linked_key_result_id) VALUES ($1,'SECRET OPP',$2) RETURNING id::text AS id`, [workspace, pointer])).rows[0].id as string
  const objective = async (workspace: string) => (await q(`INSERT INTO $S.objectives(workspace_id,title) VALUES ($1,'SECRET OBJ') RETURNING id::text AS id`, [workspace])).rows[0].id as string
  const keyResult = async (objectiveId: string) => (await q(`INSERT INTO $S.key_results(objective_id,title,target) VALUES ($1,'SECRET KR',1) RETURNING id::text AS id`, [objectiveId])).rows[0].id as string
  const solution = async (workspace: string, opportunityId: string) => (await q(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) VALUES ($1,$2,'SECRET SOL') RETURNING id::text AS id`, [workspace, opportunityId])).rows[0].id as string
  const artifact = async (workspace: string) => (await q(`INSERT INTO $S.artifacts(workspace_id,title,source_type) VALUES ($1,'SECRET ART','UPLOAD') RETURNING id::text AS id`, [workspace])).rows[0].id as string
  const task = async (workspace: string) => (await q(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'SECRET TASK') RETURNING id::text AS id`, [workspace])).rows[0].id as string
  const comment = async (workspace: string) => (await q(`INSERT INTO $S.comments(workspace_id,target_type,target_id,body,author_name) VALUES ($1,'DOC',$2,'SECRET BODY','a') RETURNING id::text AS id`, [workspace, randomUUID()])).rows[0].id as string
  const entityLink = async (workspace: string, linkType: string, fromType: string, fromId: string, toType: string, toId: string) =>
    (await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id::text AS id`, [workspace, linkType, fromType, fromId, toType, toId])).rows[0].id as string
  const skr = async (workspace: string, solutionId: string, keyResultId: string) =>
    (await q(`INSERT INTO $S.solution_key_result_links(workspace_id,solution_id,key_result_id,source,created_by_id,created_at) VALUES ($1,$2,$3,'MCP',$4,'2025-05-06 07:08:09') RETURNING id::text AS id`, [workspace, solutionId, keyResultId, actor])).rows[0].id as string
  const ool = async (workspace: string, opportunityId: string, objectiveId: string) =>
    (await q(`INSERT INTO $S.opportunity_objective_links(workspace_id,opportunity_id,objective_id,origin,source,created_by_id,created_at) VALUES ($1,$2,$3,'DIRECT','UI',$4,'2025-05-06 07:08:09') RETURNING id::text AS id`, [workspace, opportunityId, objectiveId, actor])).rows[0].id as string
  const al = async (workspace: string, artifactId: string, linkedId: string) =>
    (await q(`INSERT INTO $S.artifact_links(workspace_id,artifact_id,linked_type,linked_id,source,created_by_id,created_at) VALUES ($1,$2,'SOLUTION',$3,'UI',$4,'2025-05-06 07:08:09') RETURNING id::text AS id`, [workspace, artifactId, linkedId, actor])).rows[0].id as string
  const tl = async (taskId: string, linkedType: string, linkedId: string) =>
    (await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id,source,created_by_id,created_at) VALUES ($1,$2,$3,'UI',$4,'2025-05-06 07:08:09') RETURNING id::text AS id`, [taskId, linkedType, linkedId, actor])).rows[0].id as string

  /** Count and md5 of every row of every table these rows or their endpoints live in. */
  const fingerprint = async () => {
    const out: Record<string, string> = {}
    for (const table of ["entity_links", "solution_key_result_links", "opportunity_objective_links", "artifact_links", "task_links", "opportunities", "objectives", "key_results", "solutions", "artifacts", "tasks", "comments", "docs", "review_requests"]) {
      const { rows } = await q(`SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t.id::text)), '') AS h FROM $S.${table} AS t`)
      out[table] = `${rows[0].n}:${rows[0].h}`
    }
    return out
  }

  const listed = (status: LegacyOnlySourceStatus): Map<string, LegacyOnlyRow> => new Map(ok(status).rows.map((row) => [row.legacyId, row]))

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (!["postgresql:", "postgres:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== "/compass_e2e" || url.searchParams.has("schema")) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    for (const name of [schema, absentSchema]) {
      await pool.query(`CREATE SCHEMA "${name}"`)
      owned.push(name)
      const replay = await replayAllMigrations(pool, name)
      expect(replay.status, JSON.stringify(await replay.json())).toBe(200)
    }

    // Shared endpoints (all in ws1).
    const baseOpp = await opp(ws1)
    const objectiveId = await objective(ws1)
    const krLive = await keyResult(objectiveId)

    // ── solution_key_result_links ──
    const skrSolution = async () => solution(ws1, baseOpp)
    const sTwin = await skrSolution(); ids.skrTwin = await skr(ws1, sTwin, krLive); await entityLink(ws1, "SOLUTION_TARGETS_KEY_RESULT", "SOLUTION", sTwin, "KEY_RESULT", krLive)
    const sDel = await skrSolution(); ids.skrDeleted = await skr(ws1, sDel, krLive) // the link was unlinked: only the entity_links row went away
    ids.skrTargetGone = await skr(ws1, await skrSolution(), randomUUID()) // the key result no longer exists
    const sOther = await skrSolution(); ids.skrOther = await skr(ws1, sOther, krLive); ids.skrOtherEl = await entityLink(ws1, "SOLUTION_REFERENCES_KEY_RESULT", "KEY_RESULT", krLive, "SOLUTION", sOther) // same pair, other type and direction

    // ── opportunity_objective_links ──
    const oTwin = await opp(ws1); ids.oolTwin = await ool(ws1, oTwin, objectiveId); await entityLink(ws1, "OPPORTUNITY_TARGETS_OBJECTIVE", "OPPORTUNITY", oTwin, "OBJECTIVE", objectiveId)
    ids.oolDeleted = await ool(ws1, await opp(ws1), objectiveId)
    ids.oolTargetGone = await ool(ws1, await opp(ws1), randomUUID())
    const oOther = await opp(ws1); ids.oolOther = await ool(ws1, oOther, objectiveId); await entityLink(ws1, "OBJECTIVE_INFORMS_OPPORTUNITY", "OBJECTIVE", objectiveId, "OPPORTUNITY", oOther)

    // ── artifact_links (SOLUTION type) ──
    const aTwin = await artifact(ws1); const aSol = await skrSolution(); ids.alTwin = await al(ws1, aTwin, aSol); await entityLink(ws1, "ARTIFACT_ATTACHED_TO_SOLUTION", "ARTIFACT", aTwin, "SOLUTION", aSol)
    ids.alDeleted = await al(ws1, await artifact(ws1), aSol)
    ids.alTargetGone = await al(ws1, await artifact(ws1), randomUUID())
    const aOther = await artifact(ws1); ids.alOther = await al(ws1, aOther, aSol); await entityLink(ws1, "ARTIFACT_SUPPORTS_DECISION", "ARTIFACT", aOther, "SOLUTION", aSol)

    // ── task_links ──
    const tTwin = await task(ws1); const tOpp = await opp(ws1); ids.tlTwin = await tl(tTwin, "OPPORTUNITY", tOpp); await entityLink(ws1, "TASK_REFERENCES", "TASK", tTwin, "OPPORTUNITY", tOpp)
    ids.tlDeleted = await tl(await task(ws1), "OPPORTUNITY", tOpp)
    ids.tlTargetGone = await tl(await task(ws1), "OPPORTUNITY", randomUUID())
    const tOther = await task(ws1); const tCom = await comment(ws1); ids.tlOther = await tl(tOther, "COMMENT", tCom); await entityLink(ws1, "TASK_REFERENCES", "TASK", tOther, "COMMENT", tCom) // a COMMENT stored under the wrong type
    // A COMMENT origin link that does have its TASK_CREATED_FROM twin.
    const tOrigin = await task(ws1); const tOriginComment = await comment(ws1); ids.tlOriginTwin = await tl(tOrigin, "COMMENT", tOriginComment); await entityLink(ws1, "TASK_CREATED_FROM", "TASK", tOrigin, "COMMENT", tOriginComment)

    // ── opportunities.linked_key_result_id (the legacy id is the opportunity's) ──
    const pTwin = await opp(ws1, krLive); ids.ptrTwin = pTwin; await entityLink(ws1, "OPPORTUNITY_TARGETS_KEY_RESULT", "OPPORTUNITY", pTwin, "KEY_RESULT", krLive)
    ids.ptrDeleted = await opp(ws1, krLive)
    ids.ptrTargetGone = await opp(ws1, randomUUID())
    const pOther = await opp(ws1, krLive); ids.ptrOther = pOther; await entityLink(ws1, "KEY_RESULT_INFORMS_OPPORTUNITY", "KEY_RESULT", krLive, "OPPORTUNITY", pOther)

    // A legacy row in another workspace than its endpoints: not live (the endpoints are not in its workspace), no twin.
    ids.skrCrossWorkspace = await skr(ws2, await skrSolution(), krLive)

    // The tables-absent schema: the legacy relations are gone, as after 116.
    for (const table of ["task_links", "artifact_links", "opportunity_objective_links", "solution_key_result_links"]) await q(`DROP TABLE $S.${table}`, [], absentSchema)
    await q(`ALTER TABLE $S.opportunities DROP COLUMN linked_key_result_id`, [], absentSchema)
  }, 240_000)

  afterAll(async () => {
    for (const name of owned) await pool.query(`DROP SCHEMA "${name}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("lists exactly the legacy rows with no twin, per source, and never a row that has one", async () => {
    const before = await fingerprint()
    const status = await detail()
    expect(await fingerprint()).toEqual(before) // nothing deleted, altered, repaired or backfilled, in any table
    const sources = sourcesOf(status.legacyOnly)

    const skrRows = listed(sources.solution_key_result_links)
    expect([...skrRows.keys()].sort()).toEqual([ids.skrDeleted, ids.skrTargetGone, ids.skrOther, ids.skrCrossWorkspace].sort())
    expect(ok(sources.solution_key_result_links)).toMatchObject({ legacyDropped: false, legacyTotalCount: 5, legacyLiveCount: 3, legacyOnlyCount: 4, legacyOnlyLiveCount: 2, legacyOnlyNotLiveCount: 2, truncated: false })
    // A deleted link whose key result still exists: it blocks the preflight, both ends exist, same workspace.
    expect(skrRows.get(ids.skrDeleted)).toMatchObject({
      entityLinkType: "SOLUTION_TARGETS_KEY_RESULT", fromType: "SOLUTION", toType: "KEY_RESULT", workspaceId: ws1, createdAt: "2025-05-06T07:08:09.000Z", createdById: actor, source: "MCP", origin: null,
      fromExists: true, toExists: true, sameWorkspace: true, blocksDropPreflight: true, entityLinksTwinPresent: false, twinRowExistsButNotLive: false, pairUnderOtherLinkTypes: [],
    })
    // The key result is gone: not live, tolerated by the preflight.
    expect(skrRows.get(ids.skrTargetGone)).toMatchObject({ fromExists: true, toExists: false, sameWorkspace: false, blocksDropPreflight: false, pairUnderOtherLinkTypes: [] })
    // The pair exists in entity_links under another type and direction: a mapping mismatch, not a deleted link.
    expect(skrRows.get(ids.skrOther)).toMatchObject({ blocksDropPreflight: true, twinRowExistsButNotLive: false, pairUnderOtherLinkTypes: ["SOLUTION_REFERENCES_KEY_RESULT"] })
    // Both exist but in another workspace than the link: not live.
    expect(skrRows.get(ids.skrCrossWorkspace)).toMatchObject({ workspaceId: ws2, fromExists: true, toExists: true, sameWorkspace: false, blocksDropPreflight: false })

    for (const [source, deleted, gone, other, twin, total] of [
      ["opportunity_objective_links", ids.oolDeleted, ids.oolTargetGone, ids.oolOther, ids.oolTwin, 4],
      ["artifact_links", ids.alDeleted, ids.alTargetGone, ids.alOther, ids.alTwin, 4],
      ["task_links", ids.tlDeleted, ids.tlTargetGone, ids.tlOther, ids.tlTwin, 5],
      ["opportunities.linked_key_result_id", ids.ptrDeleted, ids.ptrTargetGone, ids.ptrOther, ids.ptrTwin, 4],
    ] as const) {
      const entry = ok(sources[source])
      const rows = listed(sources[source])
      expect([...rows.keys()].sort(), source).toEqual([deleted, gone, other].sort())
      expect(rows.has(twin), `${source} twin must not be listed`).toBe(false)
      expect(entry, source).toMatchObject({ legacyDropped: false, legacyTotalCount: total, legacyOnlyCount: 3, legacyOnlyLiveCount: 2, legacyOnlyNotLiveCount: 1, truncated: false })
      expect(rows.get(deleted), source).toMatchObject({ fromExists: true, toExists: true, sameWorkspace: true, blocksDropPreflight: true, entityLinksTwinPresent: false, pairUnderOtherLinkTypes: [] })
      expect(rows.get(gone), source).toMatchObject({ toExists: false, blocksDropPreflight: false })
      expect(rows.get(other)?.pairUnderOtherLinkTypes.length, source).toBe(1)
      expect(rows.get(other)?.blocksDropPreflight, source).toBe(true)
    }
    // Blocking rows come first.
    expect(ok(sources.solution_key_result_links).rows.slice(0, 2).every((row) => row.blocksDropPreflight)).toBe(true)

    // Metadata mapping per source.
    expect(listed(sources.opportunity_objective_links).get(ids.oolDeleted)).toMatchObject({ entityLinkType: "OPPORTUNITY_TARGETS_OBJECTIVE", fromType: "OPPORTUNITY", toType: "OBJECTIVE", origin: "DIRECT", source: "UI", createdById: actor })
    expect(listed(sources.artifact_links).get(ids.alDeleted)).toMatchObject({ entityLinkType: "ARTIFACT_ATTACHED_TO_SOLUTION", fromType: "ARTIFACT", toType: "SOLUTION" })
    expect(listed(sources.task_links).get(ids.tlDeleted)).toMatchObject({ entityLinkType: "TASK_REFERENCES", fromType: "TASK", toType: "OPPORTUNITY" })
    expect(listed(sources.task_links).get(ids.tlOther)).toMatchObject({ entityLinkType: "TASK_CREATED_FROM", toType: "COMMENT", pairUnderOtherLinkTypes: ["TASK_REFERENCES"] })
    expect(listed(sources.task_links).has(ids.tlOriginTwin)).toBe(false)
    expect(listed(sources["opportunities.linked_key_result_id"]).get(ids.ptrDeleted)).toMatchObject({
      legacyId: ids.ptrDeleted, fromId: ids.ptrDeleted, entityLinkType: "OPPORTUNITY_TARGETS_KEY_RESULT", createdAt: null, createdById: null, source: null, origin: null,
    })

    // Metadata only.
    expect(JSON.stringify(status)).not.toMatch(/SECRET/)
  })

  it("agrees with entityLinksReadParity onlyLegacy (what the 116 preflight refuses on), per source", async () => {
    const sources = sourcesOf((await detail()).legacyOnly)
    const parity = await withClient((client) => getEntityLinksReadParityStatus(client, schema))
    let totalBlocking = 0
    let totalOnlyLegacy = 0
    for (const source of LEGACY_SOURCES) {
      const entry = ok(sources[source])
      const families = FAMILIES[source].map((name) => parity.families[name])
      expect(entry.legacyOnlyLiveCount, `${source} onlyLegacy`).toBe(families.reduce((sum, family) => sum + family.onlyLegacy, 0))
      expect(entry.legacyLiveCount, `${source} legacyLive`).toBe(families.reduce((sum, family) => sum + family.legacyLive, 0))
      // The ids parity reports are exactly the blocking rows listed here.
      const parityIds = families.flatMap((family) => family.ids.onlyLegacy).sort()
      expect(entry.rows.filter((row) => row.blocksDropPreflight).map((row) => row.legacyId).sort(), source).toEqual(parityIds)
      totalBlocking += entry.legacyOnlyLiveCount
      totalOnlyLegacy += families.reduce((sum, family) => sum + family.onlyLegacy, 0)
    }
    expect(totalBlocking).toBe(totalOnlyLegacy)
    expect(totalBlocking).toBeGreaterThan(0)
  })

  it("reports legacyDropped, with no error, for a schema whose legacy tables and pointer column are gone, and still finds hidden rows", async () => {
    const status = await withClient((client) => getEntityLinksRowDetailStatus(client, absentSchema))
    const sources = sourcesOf(status.legacyOnly)
    for (const source of LEGACY_SOURCES) expect(sources[source]).toEqual({ legacyDropped: true, legacyTotalCount: 0, legacyLiveCount: 0, legacyOnlyCount: 0, legacyOnlyLiveCount: 0, legacyOnlyNotLiveCount: 0, rows: [], truncated: false })
    expect(status.rows).toEqual([])

    // The whole GET, tables absent: still 200, and the block carries no error.
    const response = await getMigrationStatus(pool, absentSchema)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.entityLinksRowDetail.error).toBeUndefined()
    expect(sourcesOf(body.entityLinksRowDetail.legacyOnly).task_links).toMatchObject({ legacyDropped: true })
  })

  it("caps at 50 rows per source with a truncated flag and the full count, and still writes nothing", async () => {
    const lonelyOpp = await opp(ws1)
    const objectiveId = await objective(ws1)
    const kr = await keyResult(objectiveId)
    for (let i = 0; i < ROW_DETAIL_CAP + 5; i += 1) await skr(ws1, await solution(ws1, lonelyOpp), kr)
    const before = await fingerprint()
    const sources = sourcesOf((await detail()).legacyOnly)
    const entry = ok(sources.solution_key_result_links)
    expect(entry.rows).toHaveLength(ROW_DETAIL_CAP)
    expect(entry.truncated).toBe(true)
    expect(entry.legacyOnlyLiveCount).toBe(2 + ROW_DETAIL_CAP + 5)
    expect(entry.rows.every((row) => row.blocksDropPreflight)).toBe(true) // blocking rows are listed before the tolerated ones
    expect(ok(sources.task_links).truncated).toBe(false)
    expect(await fingerprint()).toEqual(before)
  })
})
