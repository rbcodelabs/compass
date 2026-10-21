import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import {
  ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE,
  assertEntityLinksTaskBackfill,
  backfillEntityLinksTask,
  getEntityLinksTaskStatus,
} from "@/lib/migrations/entity-links-task-backfill"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 097 through the registered runner on a throwaway schema, with legacy task links (good and orphaned, every target type) seeded first.
 * Set ENTITY_LINKS_TASK_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = process.env.ENTITY_LINKS_TASK_DATABASE_URL
const NAME = "097_entity_links_backfill_task"
const KEY = "TASK_REFERENCES"
const TYPES = ["OPPORTUNITY", "SOLUTION", "ROADMAP_ITEM", "OBJECTIVE", "KEY_RESULT", "DOC", "EXPERIMENT", "FEEDBACK_ITEM", "DECISION"] as const
type LegacyType = (typeof TYPES)[number]
const STORED = (type: string) => (type === "DECISION" ? "REVIEW_REQUEST" : type)

describe.skipIf(!databaseUrl)("097 entity_links task backfill through the registered runner", () => {
  const schema = `entity_links_task_test_${randomUUID().replaceAll("-", "")}`
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
  const actor = randomUUID()
  const seeded: Record<string, string> = {}
  const good: Record<string, { link: string; task: string; target: string }> = {}
  const orphans = { cross: [] as string[], crossNull: [] as string[], dangling: [] as string[] }

  // One insert per fixture kind. Every objective and solution lists workspace_id; a null parameter simulates a row that predates 068.
  const objective = async (workspace: string | null) => (await q(`INSERT INTO $S.objectives(workspace_id,title) VALUES ($1,'o') RETURNING id`, [workspace])).rows[0].id as string
  const opportunity = async (workspace: string) => (await q(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'op') RETURNING id`, [workspace])).rows[0].id as string
  const solution = async (workspace: string | null) => {
    const parent = await opportunity(ws1)
    return (await q(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) VALUES ($1,$2,'s') RETURNING id`, [workspace, parent])).rows[0].id as string
  }
  const task = async (workspace: string) => (await q(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'t') RETURNING id`, [workspace])).rows[0].id as string
  /** A target of any legacy type in `workspace`; a null workspace means the target (or, for a key result, its objective) has none. */
  const target = async (type: LegacyType, workspace: string | null): Promise<string> => {
    switch (type) {
      case "OPPORTUNITY": return opportunity(workspace!)
      case "SOLUTION": return solution(workspace)
      case "OBJECTIVE": return objective(workspace)
      case "KEY_RESULT": return (await q(`INSERT INTO $S.key_results(objective_id,title,target) VALUES ($1,'kr',1) RETURNING id`, [await objective(workspace)])).rows[0].id as string
      case "ROADMAP_ITEM": return (await q(`INSERT INTO $S.roadmap_items(workspace_id,title) VALUES ($1,'r') RETURNING id`, [workspace])).rows[0].id as string
      case "DOC": return (await q(`INSERT INTO $S.docs(workspace_id,title) VALUES ($1,'d') RETURNING id`, [workspace])).rows[0].id as string
      case "EXPERIMENT": return (await q(`INSERT INTO $S.experiments(workspace_id,title,hypothesis,method,kill_condition) VALUES ($1,'e','h','m','k') RETURNING id`, [workspace])).rows[0].id as string
      case "FEEDBACK_ITEM": return (await q(`INSERT INTO $S.feedback(workspace_id,title) VALUES ($1,'f') RETURNING id`, [workspace])).rows[0].id as string
      case "DECISION": return (await q(`INSERT INTO $S.review_requests(workspace_id,gate_type,subject_type,subject_id) VALUES ($1,'TRACKED_DECISION','OPPORTUNITY',$2) RETURNING id`, [workspace, randomUUID()])).rows[0].id as string
    }
  }
  const link = async (taskId: string, linkedType: string, linkedId: string, source = "UI", by: string | null = null, createdAt = "2024-03-01 10:00:00") =>
    (await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id,source,created_by_id,created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [taskId, linkedType, linkedId, source, by, createdAt])).rows[0].id as string

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

    // Good rows: one per target type, with source / actor / created_at to be copied.
    for (const type of TYPES) {
      const taskId = await task(ws1)
      const targetId = await target(type, ws1)
      good[type] = { task: taskId, target: targetId, link: await link(taskId, type, targetId, type === "DOC" ? "MCP" : "UI", type === "DOC" ? actor : null, "2024-03-02 11:22:33") }
    }

    // More than one batch, in two different target types, to span the 500 cap (the keyset paging must not skip or repeat rows).
    const bulk = ENTITY_LINKS_TASK_BACKFILL_BATCH_SIZE + 37
    seeded.bulk = String(bulk)
    const bulkTask = await task(ws1)
    await q(`INSERT INTO $S.opportunities(workspace_id,title) SELECT $1::uuid,'bulk'||g FROM generate_series(1,${bulk}) g`, [ws1])
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) SELECT $1::uuid,'OPPORTUNITY',id FROM $S.opportunities WHERE title LIKE 'bulk%'`, [bulkTask])
    await q(`INSERT INTO $S.docs(workspace_id,title) SELECT $1::uuid,'bulkdoc'||g FROM generate_series(1,${bulk}) g`, [ws1])
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) SELECT $1::uuid,'DOC',id FROM $S.docs WHERE title LIKE 'bulkdoc%'`, [bulkTask])

    // Orphans, for EVERY target type: a target in another workspace, a target that is gone. None may be linked or deleted.
    for (const type of TYPES) {
      const t = await task(ws1)
      orphans.cross.push(await link(t, type, await target(type, ws2)))
      orphans.dangling.push(await link(await task(ws1), type, randomUUID()))
    }
    // INTENTIONAL NULL workspaceId: a target with no workspace fails closed (crossWorkspace). Only the types whose workspace can be missing.
    for (const type of ["OBJECTIVE", "SOLUTION", "KEY_RESULT"] as const) orphans.crossNull.push(await link(await task(ws1), type, await target(type, null)))
    seeded.danglingTaskLink = await link(randomUUID(), "DOC", await target("DOC", ws1)) // the task row is gone
    orphans.dangling.push(seeded.danglingTaskLink)
    seeded.crossTask = await link(await task(ws2), "DOC", await target("DOC", ws1)) // task in ws2, target in ws1
    orphans.cross.push(seeded.crossTask)
    seeded.unsupported = await link(await task(ws1), "SQUAD", randomUUID())
    // COMMENT links are legacy-only by design: never mirrored, never quarantined, never touched.
    seeded.comment1 = await link(await task(ws1), "COMMENT", randomUUID())
    seeded.comment2 = await link(good.DOC.task, "COMMENT", randomUUID())
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n)
  const mirrorCount = () => count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1`, [KEY])
  const legacyTotal = () => count(`SELECT count(*)::text AS n FROM $S.task_links`)

  it("is explicit-only: an untargeted run names it as skipped and never applies it", async () => {
    const untargeted = await run()
    const body = await untargeted.json()
    expect(`${body.message ?? ""}${body.log ?? ""}`).toMatch(/Skipped \(explicit-only, still pending\):[^\n]*097_entity_links_backfill_task/)
    expect(await count(`SELECT count(*)::text AS n FROM $S._prisma_migrations WHERE migration_name=$1`, [NAME])).toBe(0)
    expect(await mirrorCount()).toBe(0)
  }, 120_000)

  it("reports the plan before POST: unmatched and quarantined counts, every class, no write", async () => {
    const status = await withClient((client) => getEntityLinksTaskStatus(client, schema))
    const bulk = Number(seeded.bulk)
    const goodCount = 9 + 2 * bulk
    expect(status.unmatched).toBe(goodCount)
    expect(status.mirroredTaskReferences).toBe(0)
    expect(status.commentLinksExcluded).toBe(2)
    expect(status.legacyTaskLinksByType.OPPORTUNITY).toBe(1 + 9 * 0 + bulk + 2) // good + bulk + the cross and dangling orphan
    expect(status.quarantined.dangling.count).toBe(10)
    expect(status.quarantined.crossWorkspace.count).toBe(9 + 3 + 1)
    expect(status.quarantined.unsupportedType.count).toBe(1)
    expect(status.quarantined.unsupportedType.ids).toEqual([seeded.unsupported])
    expect(status.quarantined.dangling.ids).toHaveLength(10)
    expect(await mirrorCount()).toBe(0)
  })

  it("old, stale and drifted mirror rows are reconciled: pruned, or repaired in workspace, origin and type", async () => {
    // Stale: no legacy counterpart at all.
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'TASK',$3,'DOC',$4,'DIRECT')`, [ws1, KEY, randomUUID(), good.DOC.target])
    // Drifted: the OPPORTUNITY good link mirrored with a wrong workspace and origin.
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'TASK',$3,'OPPORTUNITY',$4,'LEGACY')`, [ws2, KEY, good.OPPORTUNITY.task, good.OPPORTUNITY.target])
    // Drifted: the DECISION good link mirrored under the alias, which must never be stored.
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'TASK',$3,'DECISION',$4,'DIRECT')`, [ws1, KEY, good.DECISION.task, good.DECISION.target])
    const status = await withClient((client) => getEntityLinksTaskStatus(client, schema))
    expect(status.staleMirrorRows).toBe(1)
    expect(status.unmatched).toBe(9 + 2 * Number(seeded.bulk)) // the two drifted rows are not a match either
  })

  it("POST 097 mirrors every consistent row with source, actor and created_at copied, quarantines the orphans, and proves the postconditions", async () => {
    const legacyBefore = await legacyTotal()
    const result = await run(NAME)
    const body = await result.json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(body.message).toContain("quarantined")
    expect(body.message).toContain(seeded.unsupported)
    expect(body.message).toContain(seeded.danglingTaskLink)
    const bulk = Number(seeded.bulk)

    expect(await mirrorCount()).toBe(9 + 2 * bulk)
    // One mirror row per target type, with the stored type (DECISION is REVIEW_REQUEST) and the copied columns.
    for (const type of TYPES) {
      const rows = (await q(`SELECT to_type, origin, source, created_by_id, created_at::text AS created_at, workspace_id, from_type FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, good[type].task, good[type].target])).rows
      // The two pre-existing drifted rows are repaired in place (workspace, origin, type); the repair leaves their own created_at alone.
      const repairedInPlace = type === "OPPORTUNITY" || type === "DECISION"
      expect(rows, type).toEqual([{ to_type: STORED(type), origin: "DIRECT", source: type === "DOC" ? "MCP" : "UI", created_by_id: type === "DOC" ? actor : null, created_at: repairedInPlace ? rows[0]?.created_at : "2024-03-02 11:22:33", workspace_id: ws1, from_type: "TASK" }])
    }
    // The alias never reaches a stored row, and the drifted rows were repaired in place (still one row per pair).
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND to_type='DECISION'`, [KEY])).toBe(0)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, good.OPPORTUNITY.task, good.OPPORTUNITY.target])).toBe(1)
    // The stale row is gone.
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND to_id=$2 AND to_type='DOC' AND workspace_id=$3`, [KEY, good.DOC.target, ws1])).toBe(1)

    // Orphans: never linked...
    for (const id of [...orphans.cross, ...orphans.crossNull, ...orphans.dangling, seeded.unsupported, seeded.comment1, seeded.comment2]) {
      expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links e JOIN $S.task_links l ON l.task_id = e.from_id AND l.linked_id = e.to_id WHERE e.link_type=$1 AND l.id=$2`, [KEY, id])).toBe(0)
    }
    // ...and never deleted or touched.
    expect(await legacyTotal()).toBe(legacyBefore)
    for (const id of [...orphans.cross, ...orphans.crossNull, ...orphans.dangling, seeded.unsupported, seeded.comment1, seeded.comment2]) {
      expect(await count(`SELECT count(*)::text AS n FROM $S.task_links WHERE id=$1`, [id])).toBe(1)
    }

    await withClient((client) => assertEntityLinksTaskBackfill(client, schema))
    const status = await withClient((client) => getEntityLinksTaskStatus(client, schema))
    expect(status.unmatched).toBe(0)
    expect(status.staleMirrorRows).toBe(0)
    expect(status.mirroredTaskReferences).toBe(9 + 2 * bulk)
    expect(await count(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [NAME])).toBe(1)
  }, 240_000)

  it("a re-run of the hook is idempotent: nothing inserted, repaired or pruned, same counts and quarantine", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links`)
    const log: string[] = []
    const again = await withClient((client) => backfillEntityLinksTask(client, schema, log))
    expect({ pruned: again.pruned, repaired: again.repaired, inserted: again.inserted }).toEqual({ pruned: 0, repaired: 0, inserted: 0 })
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
    expect(again.quarantined.dangling.count).toBe(10)
    expect(again.quarantined.unsupportedType.count).toBe(1)
    const second = await run(NAME)
    expect(second.status).toBe(200)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
  }, 240_000)

  it("a resumed run repairs drift introduced after the receipt (a deleted legacy row, a drifted stamp, a new link) and still passes", async () => {
    await q(`DELETE FROM $S.task_links WHERE id=$1`, [good.SOLUTION.link])
    await q(`UPDATE $S.entity_links SET workspace_id=$2, origin='LEGACY' WHERE link_type=$1 AND from_id=$3`, [KEY, ws2, good.EXPERIMENT.task])
    const fresh = await link(good.FEEDBACK_ITEM.task, "DOC", good.DOC.target) // a link written by an old instance, unmirrored
    const log: string[] = []
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksTask(client, schema, log)
      await assertEntityLinksTaskBackfill(client, schema)
      return done
    })
    expect(result.pruned).toBe(1)
    expect(result.repaired).toBe(1)
    expect(result.inserted).toBe(1)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [KEY, good.SOLUTION.task])).toBe(0)
    expect((await q(`SELECT workspace_id, origin FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [KEY, good.EXPERIMENT.task])).rows).toEqual([{ workspace_id: ws1, origin: "DIRECT" }])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links e JOIN $S.task_links l ON l.task_id=e.from_id AND l.linked_id=e.to_id WHERE e.link_type=$1 AND l.id=$2`, [KEY, fresh])).toBe(1)
  }, 240_000)

  it("refuses the receipt when a workspace-mismatched mirror row survives (postconditions fail closed), and a re-run repairs it", async () => {
    const victim = (await q(`SELECT id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [KEY])).rows[0].id
    await q(`UPDATE $S.entity_links SET workspace_id=$2 WHERE id=$1`, [victim, ws2])
    await expect(withClient((client) => assertEntityLinksTaskBackfill(client, schema))).rejects.toThrow(/postcondition failed/)
    await withClient((client) => backfillEntityLinksTask(client, schema, []))
    await withClient((client) => assertEntityLinksTaskBackfill(client, schema))
  }, 120_000)

  it("refuses the receipt on a duplicate pair", async () => {
    // The unique pair index normally prevents this; drop it in the throwaway schema to prove the postcondition itself.
    await q(`DROP INDEX IF EXISTS $S.idx_entity_links_pair`)
    const row = (await q(`SELECT workspace_id, from_id, to_type, to_id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [KEY])).rows[0]
    const dup = (await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'TASK',$3,$4,$5,'DIRECT') RETURNING id`, [row.workspace_id, KEY, row.from_id, row.to_type, row.to_id])).rows[0].id
    await expect(withClient((client) => assertEntityLinksTaskBackfill(client, schema))).rejects.toThrow(/uniqueness postcondition failed/)
    await q(`DELETE FROM $S.entity_links WHERE id=$1`, [dup])
    await q(`CREATE UNIQUE INDEX idx_entity_links_pair ON $S.entity_links (from_id, link_type, to_id)`)
    await withClient((client) => assertEntityLinksTaskBackfill(client, schema))
  }, 120_000)

  it("mirror rows whose legacy row became quarantined are kept and reported, never deleted, and the postconditions still pass", async () => {
    const before = await mirrorCount()
    // Delete the DOC target of a mirrored good link and of the bulk docs' first batch: their legacy rows become dangling.
    await q(`DELETE FROM $S.docs WHERE title LIKE 'bulkdoc%'`)
    const log: string[] = []
    const result = await withClient(async (client) => {
      const done = await backfillEntityLinksTask(client, schema, log)
      await assertEntityLinksTaskBackfill(client, schema)
      return done
    })
    expect(result.pruned).toBe(0)
    expect(await mirrorCount()).toBe(before)
    expect(result.keptMirrorRows.count).toBe(Number(seeded.bulk))
    expect(result.keptMirrorRows.ids).toHaveLength(50)
    expect(log.join("\n")).toContain("mirror row(s) whose legacy row is quarantined, not deleted")
    const status = await withClient((client) => getEntityLinksTaskStatus(client, schema))
    expect(status.mirrorRowsKeptForQuarantine.count).toBe(Number(seeded.bulk))
    expect(status.quarantined.dangling.count).toBe(10 + Number(seeded.bulk))
  }, 120_000)
})
