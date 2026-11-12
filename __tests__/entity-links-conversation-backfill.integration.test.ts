import { randomUUID } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  assertEntityLinksConversationBackfill,
  backfillEntityLinksConversation,
  getEntityLinksConversationStatus,
} from "@/lib/migrations/entity-links-conversation-backfill"
import { integrationDatabaseUrl } from "@/__tests__/helpers/integration-database"

/**
 * 113 against real Postgres on a throwaway schema cloned from `compass_dev` (so the e2e database must have been prepared with
 * `pnpm e2e:db:prepare`), with legacy AGENT_CONVERSATION task links seeded: good, dangling and cross-workspace, plus a MENTIONS row the
 * backfill must remove. Set INTEGRATION_TEST_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = integrationDatabaseUrl
const CREATED = "CONVERSATION_CREATED"
const MENTIONS = "CONVERSATION_MENTIONS"

describe.skipIf(!databaseUrl)("113 entity_links conversation backfill", () => {
  const schema = `entity_links_conv_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  let client: PoolClient
  const wsA = randomUUID()
  const wsB = randomUUID()
  const user = randomUUID()
  const convGood = randomUUID()
  const convOther = randomUUID()
  const taskGood = randomUUID()
  const taskShadowed = randomUUID()
  const taskOtherWs = randomUUID()
  const missing = randomUUID()
  const q = (sql: string, params: unknown[] = []) => client.query(sql.replaceAll("$S", `"${schema}"`), params)

  beforeAll(async () => {
    client = await pool.connect()
    await q(`CREATE SCHEMA $S`)
    for (const table of ["entity_links", "task_links", "tasks", "agent_conversations"]) {
      await q(`CREATE TABLE $S.${table} (LIKE "compass_dev".${table} INCLUDING DEFAULTS INCLUDING INDEXES)`)
    }
    await q(`CREATE TABLE $S._prisma_migrations (migration_name text, finished_at timestamptz)`)
    await q(`INSERT INTO $S._prisma_migrations VALUES ('091_entity_links', now())`)
    await q(`INSERT INTO $S.agent_conversations (id, workspace_id, user_id, created_at, updated_at) VALUES ($1,$2,$3,now(),now()), ($4,$5,$3,now(),now())`, [convGood, wsA, user, convOther, wsB])
    await q(`INSERT INTO $S.tasks (id, workspace_id, title) VALUES ($1,$4,'good'), ($2,$4,'shadowed'), ($3,$5,'other workspace')`, [taskGood, taskShadowed, taskOtherWs, wsA, wsB])
    const legacy = (task: string, conversation: string) =>
      q(`INSERT INTO $S.task_links (id, task_id, linked_type, linked_id, created_at) VALUES (gen_random_uuid(), $1, 'AGENT_CONVERSATION', $2, '2026-01-02T03:04:05Z')`, [task, conversation])
    await legacy(taskGood, convGood)
    await legacy(taskShadowed, convGood)
    await legacy(taskOtherWs, convGood) // task in workspace B, conversation in A: crossWorkspace
    await legacy(taskGood, missing) // conversation gone: dangling
    await q(
      `INSERT INTO $S.entity_links (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_at, updated_at)
       VALUES ($1, '${MENTIONS}', 'AGENT_CONVERSATION', $2, 'TASK', $3, 'DIRECT', 'AGENT', now(), now())`,
      [wsA, convGood, taskShadowed],
    )
  })

  afterAll(async () => {
    await q(`DROP SCHEMA $S CASCADE`)
    client.release()
    await pool.end()
  })

  it("links only the consistent rows, copies created_at, removes the shadowed MENTIONS row and reports the quarantine", async () => {
    const log: string[] = []
    const result = await backfillEntityLinksConversation(client, schema, log)
    expect(result.inserted).toBe(2)
    expect(result.mentionsRemoved).toBe(1)
    expect(result.quarantined.dangling.count).toBe(1)
    expect(result.quarantined.crossWorkspace.count).toBe(1)
    const { rows } = await q(`SELECT link_type, to_id, workspace_id, origin, source, created_by_id, created_at FROM $S.entity_links ORDER BY to_id`)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.link_type === CREATED && r.workspace_id === wsA && r.origin === "MIGRATION" && r.source === "AGENT" && r.created_by_id === null)).toBe(true)
    expect(rows.map((r) => r.to_id).sort()).toEqual([taskGood, taskShadowed].sort())
    expect(new Date(rows[0].created_at).toISOString()).toBe("2026-01-02T03:04:05.000Z")
    expect(log.join("\n")).toContain("quarantined 1 task_links row(s) of class dangling")
    await assertEntityLinksConversationBackfill(client, schema)
    // The legacy rows are untouched: task_links stays the source of truth.
    expect((await q(`SELECT count(*)::int AS n FROM $S.task_links`)).rows[0].n).toBe(4)
  })

  it("is idempotent: a re-run changes nothing and the status shows nothing left to do", async () => {
    const again = await backfillEntityLinksConversation(client, schema, [])
    expect(again).toMatchObject({ inserted: 0, mentionsRemoved: 0 })
    expect((await q(`SELECT count(*)::int AS n FROM $S.entity_links`)).rows[0].n).toBe(2)
    expect(await getEntityLinksConversationStatus(client, schema)).toMatchObject({ legacyConversationLinks: 4, linkedCreated: 2, unmatched: 0 })
  })

  it("the postconditions refuse a consistent legacy row that lost its link", async () => {
    await q(`DELETE FROM $S.entity_links WHERE to_id = $1`, [taskGood])
    await expect(assertEntityLinksConversationBackfill(client, schema)).rejects.toThrow(/coverage postcondition failed: 1/)
    expect(await backfillEntityLinksConversation(client, schema, [])).toMatchObject({ inserted: 1 })
    await assertEntityLinksConversationBackfill(client, schema)
  })
})
