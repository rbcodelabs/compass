import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getMigrationStatus } from "@/lib/migrations/runner"
import { ROW_DETAIL_CAP, getEntityLinksRowDetailStatus } from "@/lib/migrations/entity-links-row-detail"
import { getEntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity"
import { replayAllMigrations } from "./helpers/replay-migrations"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * entityLinksRowDetail against a real Postgres, on a throwaway schema built by replaying every migration (so the entity tables have their
 * real shape). Set INTEGRATION_TEST_DATABASE_URL to the local compass_e2e database (Postgres 16) to enable.
 */
const databaseUrl = integrationDatabaseUrl

describe.skipIf(!databaseUrl)("entityLinksRowDetail (read-only status block) on a real Postgres", () => {
  const schema = `row_detail_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  let owned = false
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("$S", `"${schema}"`), params)
  const withClient = async <T>(work: (client: import("pg").PoolClient) => Promise<T>) => {
    const client = await pool.connect()
    try { return await work(client) } finally { client.release() }
  }
  const detail = async () => withClient(async (client) => getEntityLinksRowDetailStatus(client, schema, await getEntityLinksReadParityStatus(client, schema)))

  const ws1 = randomUUID()
  const ws2 = randomUUID()
  const actor = randomUUID()
  const ids = {} as Record<string, string>

  const task = async (workspace: string) => (await q(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'SECRET TASK TITLE') RETURNING id`, [workspace])).rows[0].id as string
  const opportunity = async (workspace: string) => (await q(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'SECRET OPP TITLE') RETURNING id`, [workspace])).rows[0].id as string
  const comment = async (workspace: string) =>
    (await q(`INSERT INTO $S.comments(workspace_id,target_type,target_id,body,author_name) VALUES ($1,'DOC',$2,'SECRET COMMENT BODY','a') RETURNING id`, [workspace, randomUUID()])).rows[0].id as string
  const entityLink = async (workspace: string, linkType: string, fromId: string, toType: string, toId: string, extra: { by?: string | null; source?: string; origin?: string } = {}) =>
    (await q(
      `INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id,origin,source,created_by_id,created_at) VALUES ($1,$2,'TASK',$3,$4,$5,$6,$7,$8,'2026-02-03 04:05:06') RETURNING id::text AS id`,
      [workspace, linkType, fromId, toType, toId, extra.origin ?? "DIRECT", extra.source ?? "UI", extra.by ?? null],
    )).rows[0].id as string

  /** Row counts and an md5 over every row of the tables this status reads or could be mistaken for writing to. */
  const fingerprint = async () => {
    const out: Record<string, string> = {}
    for (const table of ["entity_links", "tasks", "opportunities", "comments", "task_links", "docs", "review_requests"]) {
      const { rows } = await q(`SELECT count(*)::text AS n, coalesce(md5(string_agg(t::text, '|' ORDER BY t.id::text)), '') AS h FROM $S.${table} AS t`)
      out[table] = `${rows[0].n}:${rows[0].h}`
    }
    return out
  }

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

    // 1. Resolvable, with a legacy twin: in no parity set, not hidden -> must NOT be listed.
    const twinTask = await task(ws1)
    const twinOpp = await opportunity(ws1)
    await q(`INSERT INTO $S.task_links(task_id,linked_type,linked_id) VALUES ($1,'OPPORTUNITY',$2)`, [twinTask, twinOpp])
    ids.twin = await entityLink(ws1, "TASK_REFERENCES", twinTask, "OPPORTUNITY", twinOpp)

    // 2. entity_links-only and VISIBLE (a link made after the cleanup): listed through parity (onlyEntityLinks), but not hidden and readers return it.
    const visibleTask = await task(ws1)
    ids.visible = await entityLink(ws1, "TASK_CREATED_FROM", visibleTask, "COMMENT", await comment(ws1), { by: actor, source: "MCP", origin: "DIRECT" })

    // 3. COMMENT-style: TASK_CREATED_FROM whose comment is gone (the shape of 5be2ddd1).
    ids.commentGone = await entityLink(ws1, "TASK_CREATED_FROM", await task(ws1), "COMMENT", randomUUID(), { by: actor, source: "MIGRATION", origin: "MIGRATION" })

    // 4. TASK_REFERENCES with no legacy twin whose task is gone (the shape of d8faeeb4).
    ids.taskGone = await entityLink(ws1, "TASK_REFERENCES", randomUUID(), "OPPORTUNITY", await opportunity(ws1))

    // 5. Both exist but in different workspaces: the readers drop it.
    ids.crossWorkspace = await entityLink(ws1, "TASK_REFERENCES", await task(ws1), "OPPORTUNITY", await opportunity(ws2))

    // 6. A non-task link type with a dangling endpoint: out of the hidden scan's scope entirely.
    ids.otherType = await entityLink(ws1, "SOLUTION_TARGETS_KEY_RESULT", randomUUID(), "KEY_RESULT", randomUUID())
  }, 240_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  it("lists exactly the hidden task-owned rows, with the right booleans, and the parity row it was asked to explain", async () => {
    const before = await fingerprint()
    const status = await detail()
    const after = await fingerprint()
    expect(after).toEqual(before) // nothing deleted, altered, repaired or backfilled

    const byId = new Map(status.rows.map((row) => [row.id, row]))
    expect(status.truncated).toBe(false)
    expect(status.rows.filter((row) => row.hiddenTaskLink).map((row) => row.id).sort()).toEqual([ids.commentGone, ids.taskGone, ids.crossWorkspace].sort())
    // Not listed: the resolvable twin and the non-task link type.
    expect(byId.has(ids.twin)).toBe(false)
    expect(byId.has(ids.otherType)).toBe(false)

    expect(byId.get(ids.commentGone)).toMatchObject({
      linkType: "TASK_CREATED_FROM", fromType: "TASK", toType: "COMMENT", workspaceId: ws1, createdById: actor, source: "MIGRATION", origin: "MIGRATION",
      createdAt: "2026-02-03T04:05:06.000Z", fromExists: true, toExists: false, sameWorkspace: false, fromResolves: true, toResolves: false,
      wouldBeReturnedByTaskLinkReaders: false, hiddenTaskLink: true, parity: [],
    })
    expect(byId.get(ids.taskGone)).toMatchObject({
      linkType: "TASK_REFERENCES", toType: "OPPORTUNITY", fromExists: false, toExists: true, sameWorkspace: false, fromResolves: false, toResolves: true,
      wouldBeReturnedByTaskLinkReaders: false, hiddenTaskLink: true,
    })
    expect(byId.get(ids.crossWorkspace)).toMatchObject({
      fromExists: true, toExists: true, sameWorkspace: false, fromResolves: true, toResolves: false, wouldBeReturnedByTaskLinkReaders: false, hiddenTaskLink: true,
    })
    // The visible entity_links-only row is explained through parity, and the readers DO return it.
    expect(byId.get(ids.visible)).toMatchObject({
      linkType: "TASK_CREATED_FROM", fromExists: true, toExists: true, sameWorkspace: true, wouldBeReturnedByTaskLinkReaders: true, hiddenTaskLink: false,
      parity: [{ family: "taskCreatedFrom", set: "onlyEntityLinks" }],
    })
    expect(status.rows).toHaveLength(4)
  })

  it("returns metadata only: no title, body or other content from any table", async () => {
    const text = JSON.stringify(await detail())
    expect(text).not.toMatch(/SECRET/)
    for (const row of (await detail()).rows) {
      expect(Object.keys(row).sort()).toEqual([
        "createdAt", "createdById", "fromExists", "fromId", "fromResolves", "fromType", "hiddenTaskLink", "id", "linkType", "origin", "parity", "sameWorkspace",
        "source", "toExists", "toId", "toResolves", "toType", "workspaceId", "wouldBeReturnedByTaskLinkReaders",
      ])
    }
  })

  it("agrees with GET /api/admin/migrate and the whole GET still succeeds when the block throws", async () => {
    const ok = await getMigrationStatus(pool, schema)
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.entityLinksRowDetail.rows.map((row: { id: string }) => row.id).sort()).toEqual([ids.commentGone, ids.taskGone, ids.crossWorkspace, ids.visible].sort())

    // Break the tables the block reads (docs is one of its existence tables); the block reports its own error, the GET is untouched.
    await q(`ALTER TABLE $S.docs RENAME TO docs_hidden`)
    try {
      const broken = await getMigrationStatus(pool, schema)
      expect(broken.status).toBe(200)
      const brokenBody = await broken.json()
      expect(typeof brokenBody.entityLinksRowDetail.error).toBe("string")
      expect(brokenBody.entityLinksRowDetail.rows).toBeUndefined()
      expect(brokenBody.manifest).toEqual(body.manifest)
    } finally {
      await q(`ALTER TABLE $S.docs_hidden RENAME TO docs`)
    }
  })

  it("caps at 50 rows and says it was truncated; a second look finds the same cap, and still writes nothing", async () => {
    const taskId = await task(ws1)
    const opp = await opportunity(ws1)
    await q(
      `INSERT INTO $S.entity_links(workspace_id,link_type,from_type,from_id,to_type,to_id) SELECT $1::uuid,'TASK_REFERENCES','TASK',$2::uuid,'OPPORTUNITY',gen_random_uuid() FROM generate_series(1,${ROW_DETAIL_CAP + 5}) g`,
      [ws1, taskId],
    )
    expect(opp).toBeTruthy()
    const before = await fingerprint()
    const status = await detail()
    expect(status.rows).toHaveLength(ROW_DETAIL_CAP)
    expect(status.truncated).toBe(true)
    expect(await fingerprint()).toEqual(before)
  })
})
