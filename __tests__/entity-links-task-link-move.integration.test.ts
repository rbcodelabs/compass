import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import {
  ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE,
  assertEntityLinksTaskLinkMove,
  getEntityLinksTaskLinkMoveStatus,
  moveTaskLinksToEntityLinks,
} from "@/lib/migrations/entity-links-task-link-move"
import { getEntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * 115 through the registered runner on a throwaway schema, with COMMENT and AGENT_CONVERSATION task links (good and orphaned) seeded first.
 * Set INTEGRATION_TEST_DATABASE_URL to the local compass_e2e database (Postgres 16) to enable.
 */
const databaseUrl = integrationDatabaseUrl
const NAME = "115_entity_links_task_link_move"
const KEY = "TASK_CREATED_FROM"
const TYPES = ["COMMENT", "AGENT_CONVERSATION"] as const
type Origin = (typeof TYPES)[number]

describe.skipIf(!databaseUrl)("115 entity_links task link move through the registered runner", () => {
  const schema = `entity_links_move_test_${randomUUID().replaceAll("-", "")}`
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
  const user = randomUUID()
  const actor = randomUUID()
  const seeded: Record<string, string> = {}
  const good: Record<Origin, { link: string; task: string; target: string }> = {} as never
  const orphans = { cross: [] as string[], dangling: [] as string[] }

  const task = async (workspace: string) => (await q(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'t') RETURNING id`, [workspace])).rows[0].id as string
  const target = async (type: Origin, workspace: string): Promise<string> =>
    type === "COMMENT"
      ? ((await q(`INSERT INTO $S.comments(workspace_id,target_type,target_id,body,author_name) VALUES ($1,'DOC',$2,'b','a') RETURNING id`, [workspace, randomUUID()])).rows[0].id as string)
      : ((await q(`INSERT INTO $S.agent_conversations(workspace_id,user_id,created_at,updated_at) VALUES ($1,$2,now(),now()) RETURNING id`, [workspace, user])).rows[0].id as string)
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

    // Good rows: one per type, with source / actor / created_at to be copied.
    for (const type of TYPES) {
      const taskId = await task(ws1)
      const targetId = await target(type, ws1)
      good[type] = { task: taskId, target: targetId, link: await link(taskId, type, targetId, type === "COMMENT" ? "MCP" : "AGENT", type === "COMMENT" ? actor : null, "2024-03-02 11:22:33") }
    }

    // More than one batch, in both types, to span the 500 cap (the keyset paging must not skip or repeat rows).
    const bulk = ENTITY_LINKS_TASK_LINK_MOVE_BATCH_SIZE + 37
    seeded.bulk = String(bulk)
    const bulkTask = await task(ws1)
    await q(`INSERT INTO $S.comments(workspace_id,target_type,target_id,body,author_name) SELECT $1::uuid,'DOC',gen_random_uuid(),'bulk'||g,'a' FROM generate_series(1,${bulk}) g`, [ws1])
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) SELECT $1::uuid,'COMMENT',id FROM $S.comments WHERE body LIKE 'bulk%'`, [bulkTask])
    await q(`INSERT INTO $S.agent_conversations(workspace_id,user_id,title,created_at,updated_at) SELECT $1::uuid,$2::uuid,'bulkconv'||g,now(),now() FROM generate_series(1,${bulk}) g`, [ws1, user])
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) SELECT $1::uuid,'AGENT_CONVERSATION',id FROM $S.agent_conversations WHERE title LIKE 'bulkconv%'`, [bulkTask])

    // Orphans, for BOTH types: a target in another workspace, a target that is gone, a task that is gone, a task in another workspace.
    for (const type of TYPES) {
      orphans.cross.push(await link(await task(ws1), type, await target(type, ws2)))
      orphans.dangling.push(await link(await task(ws1), type, randomUUID()))
      orphans.dangling.push(await link(randomUUID(), type, await target(type, ws1)))
      orphans.cross.push(await link(await task(ws2), type, await target(type, ws1)))
    }
    // The nine association kinds are NOT this migration's: they must come through untouched.
    seeded.doc = await link(await task(ws1), "DOC", randomUUID())
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params)).rows[0].n)
  const movedCount = (type?: Origin) => count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE link_type=$1 ${type ? `AND to_type='${type}'` : ""}`, [KEY])
  const legacyTotal = () => count(`SELECT count(*)::text AS n FROM $S.task_links`)
  const bulkTotal = () => 2 * Number(seeded.bulk)

  it("is explicit-only: an untargeted run names it as skipped and never applies it", async () => {
    const untargeted = await run()
    const body = await untargeted.json()
    expect(`${body.message ?? ""}${body.log ?? ""}`).toMatch(/Skipped \(explicit-only, still pending\):[^\n]*115_entity_links_task_link_move/)
    expect(await count(`SELECT count(*)::text AS n FROM $S._prisma_migrations WHERE migration_name=$1`, [NAME])).toBe(0)
    expect(await movedCount()).toBe(0)
  }, 120_000)

  it("reports the plan before POST: unmoved and quarantined counts per type, no write", async () => {
    const status = await withClient((client) => getEntityLinksTaskLinkMoveStatus(client, schema))
    const bulk = Number(seeded.bulk)
    expect(status.types.COMMENT).toMatchObject({ consistent: 1 + bulk, unmoved: 1 + bulk, entityLinks: 0 })
    expect(status.types.AGENT_CONVERSATION).toMatchObject({ consistent: 1 + bulk, unmoved: 1 + bulk, entityLinks: 0 })
    expect(status.unmoved).toBe(2 * (1 + bulk))
    expect(status.quarantined.dangling.count).toBe(4)
    expect(status.quarantined.crossWorkspace.count).toBe(4)
    expect(await movedCount()).toBe(0)
    // The parity status sees the same: every live legacy row is waiting for the move.
    const parity = await withClient((client) => getEntityLinksReadParityStatus(client, schema))
    expect(parity.unmovedTaskOriginLinks).toBe(2 * (1 + bulk))
    expect(parity.families.taskCreatedFrom).toMatchObject({ legacyLive: 2 * (1 + bulk), mirrorLive: 0, onlyLegacy: 2 * (1 + bulk) })
  })

  it("repairs a pre-existing drifted row and keeps a link written by the new code after the deploy", async () => {
    // Drifted: the COMMENT good link already has a TASK_CREATED_FROM row, in the wrong workspace (a half-finished earlier run).
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'TASK',$3,'COMMENT',$4,'DIRECT')`, [ws2, KEY, good.COMMENT.task, good.COMMENT.target])
    // New: written by the deployed code, has no legacy row, and must survive the move untouched.
    seeded.newTask = await task(ws1)
    seeded.newTarget = await target("COMMENT", ws1)
    await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin,source) VALUES ($1,$2,'TASK',$3,'COMMENT',$4,'DIRECT','AGENT')`, [ws1, KEY, seeded.newTask, seeded.newTarget])
    const status = await withClient((client) => getEntityLinksTaskLinkMoveStatus(client, schema))
    expect(status.types.COMMENT.unmoved).toBe(1 + Number(seeded.bulk)) // the drifted row is not a match either
  })

  it("POST 115 copies every consistent row with id, source, actor and created_at kept, quarantines the orphans, and proves the postconditions", async () => {
    const legacyBefore = await legacyTotal()
    const result = await run(NAME)
    const body = await result.json()
    expect(result.status, JSON.stringify(body)).toBe(200)
    expect(body.message).toContain("quarantined")
    for (const id of [...orphans.cross, ...orphans.dangling]) expect(body.message).toContain(id)
    const bulk = Number(seeded.bulk)

    // Per type: the consistent legacy rows and the new-code row are all there.
    expect(await movedCount("COMMENT")).toBe(1 + bulk + 1)
    expect(await movedCount("AGENT_CONVERSATION")).toBe(1 + bulk)
    // The copy keeps the legacy id, the stored columns and the task's workspace (the drifted COMMENT row was repaired in place).
    for (const type of TYPES) {
      const rows = (await q(`SELECT id, to_type, origin, source, created_by_id, created_at::text AS created_at, workspace_id, from_type FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, good[type].task, good[type].target])).rows
      expect(rows, type).toHaveLength(1)
      expect(rows[0], type).toMatchObject({ to_type: type, source: type === "COMMENT" ? "UI" : "AGENT", workspace_id: ws1, from_type: "TASK" })
      if (type === "AGENT_CONVERSATION") expect(rows[0]).toMatchObject({ id: good[type].link, origin: "MIGRATION", created_by_id: null, created_at: "2024-03-02 11:22:33" })
    }
    // The repaired COMMENT row was a pre-existing one, so it keeps its own id and stamp; its workspace is fixed.
    expect((await q(`SELECT workspace_id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2`, [KEY, good.COMMENT.task])).rows).toEqual([{ workspace_id: ws1 }])
    // The code-written row is untouched.
    expect((await q(`SELECT origin, source FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, seeded.newTask, seeded.newTarget])).rows).toEqual([{ origin: "DIRECT", source: "AGENT" }])
    // Bulk rows span the 500 batch: none skipped, none repeated.
    // (The drifted COMMENT row is the only copy that does not carry its legacy id.)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links e JOIN $S.task_links l ON l.id = e.id WHERE e.link_type=$1`, [KEY])).toBe(1 + bulkTotal())

    // Orphans: never copied...
    for (const id of [...orphans.cross, ...orphans.dangling]) {
      expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE id=$1`, [id])).toBe(0)
    }
    // ...and the legacy table is untouched: insert-only, nothing deleted, nothing changed, the association rows included.
    expect(await legacyTotal()).toBe(legacyBefore)
    expect(await count(`SELECT count(*)::text AS n FROM $S.task_links WHERE id=$1`, [seeded.doc])).toBe(1)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE id=$1`, [seeded.doc])).toBe(0)

    await withClient((client) => assertEntityLinksTaskLinkMove(client, schema))
    const status = await withClient((client) => getEntityLinksTaskLinkMoveStatus(client, schema))
    expect(status.unmoved).toBe(0)
    expect(status.types.COMMENT.unmoved).toBe(0)
    expect(status.types.AGENT_CONVERSATION.unmoved).toBe(0)
    expect(status.quarantined.dangling.count).toBe(4)
    expect(status.quarantined.crossWorkspace.count).toBe(4)
    expect(await count(`SELECT count(*)::int AS n FROM $S._prisma_migrations WHERE migration_name=$1 AND finished_at IS NOT NULL`, [NAME])).toBe(1)
    // The parity status reports zero unmoved live rows; the only difference left is the link the new code wrote.
    const parity = await withClient((client) => getEntityLinksReadParityStatus(client, schema))
    expect(parity.unmovedTaskOriginLinks).toBe(0)
    expect(parity.families.taskCreatedFrom).toMatchObject({ onlyLegacy: 0, onlyEntityLinks: 1 })
  }, 240_000)

  it("a re-run is idempotent: nothing inserted or repaired, same counts and quarantine", async () => {
    const before = await count(`SELECT count(*)::text AS n FROM $S.entity_links`)
    const log: string[] = []
    const again = await withClient((client) => moveTaskLinksToEntityLinks(client, schema, log))
    expect({ repaired: again.repaired, inserted: again.inserted }).toEqual({ repaired: 0, inserted: { COMMENT: 0, AGENT_CONVERSATION: 0 } })
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
    expect(again.quarantined.dangling.count).toBe(4)
    const second = await run(NAME)
    expect(second.status).toBe(200)
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links`)).toBe(before)
  }, 240_000)

  it("a resumed run picks up a link written by an old instance after the receipt (and a unlinked-since legacy row is not resurrected)", async () => {
    const lateTask = await task(ws1)
    const lateTarget = await target("AGENT_CONVERSATION", ws1)
    const late = await link(lateTask, "AGENT_CONVERSATION", lateTarget) // an old instance still writing task_links
    const gone = await link(await task(ws1), "COMMENT", await target("COMMENT", ws1))
    await q(`DELETE FROM $S.task_links WHERE id=$1`, [gone]) // unlinked before the move got to it
    const result = await withClient(async (client) => {
      const done = await moveTaskLinksToEntityLinks(client, schema, [])
      await assertEntityLinksTaskLinkMove(client, schema)
      return done
    })
    expect(result.inserted).toEqual({ COMMENT: 0, AGENT_CONVERSATION: 1 })
    expect((await q(`SELECT id FROM $S.entity_links WHERE link_type=$1 AND from_id=$2 AND to_id=$3`, [KEY, lateTask, lateTarget])).rows).toEqual([{ id: late }])
    expect(await count(`SELECT count(*)::text AS n FROM $S.entity_links WHERE id=$1`, [gone])).toBe(0)
  }, 120_000)

  it("refuses the receipt when a workspace-mismatched row survives (postconditions fail closed), and a re-run repairs it", async () => {
    const victim = (await q(`SELECT id FROM $S.entity_links WHERE link_type=$1 AND to_type='AGENT_CONVERSATION' LIMIT 1`, [KEY])).rows[0].id
    await q(`UPDATE $S.entity_links SET workspace_id=$2 WHERE id=$1`, [victim, ws2])
    await expect(withClient((client) => assertEntityLinksTaskLinkMove(client, schema))).rejects.toThrow(/postcondition failed/)
    await withClient((client) => moveTaskLinksToEntityLinks(client, schema, []))
    await withClient((client) => assertEntityLinksTaskLinkMove(client, schema))
  }, 120_000)

  it("refuses the receipt when a copied row is missing (pair-set equality), and a re-run restores it", async () => {
    await q(`DELETE FROM $S.entity_links WHERE id=$1`, [good.AGENT_CONVERSATION.link])
    await expect(withClient((client) => assertEntityLinksTaskLinkMove(client, schema))).rejects.toThrow(/coverage postcondition failed: 1 consistent AGENT_CONVERSATION/)
    const again = await withClient((client) => moveTaskLinksToEntityLinks(client, schema, []))
    expect(again.inserted.AGENT_CONVERSATION).toBe(1)
    await withClient((client) => assertEntityLinksTaskLinkMove(client, schema))
  }, 120_000)

  it("refuses the receipt on a duplicate pair", async () => {
    // The unique pair index normally prevents this; drop it in the throwaway schema to prove the postcondition itself.
    await q(`DROP INDEX IF EXISTS $S.idx_entity_links_pair`)
    const row = (await q(`SELECT workspace_id, from_id, to_type, to_id FROM $S.entity_links WHERE link_type=$1 LIMIT 1`, [KEY])).rows[0]
    const dup = (await q(`INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin) VALUES ($1,$2,'TASK',$3,$4,$5,'DIRECT') RETURNING id`, [row.workspace_id, KEY, row.from_id, row.to_type, row.to_id])).rows[0].id
    await expect(withClient((client) => assertEntityLinksTaskLinkMove(client, schema))).rejects.toThrow(/(uniqueness|count) postcondition failed/)
    await q(`DELETE FROM $S.entity_links WHERE id=$1`, [dup])
    await q(`CREATE UNIQUE INDEX idx_entity_links_pair ON $S.entity_links (from_id, link_type, to_id)`)
    await withClient((client) => assertEntityLinksTaskLinkMove(client, schema))
  }, 120_000)
})
