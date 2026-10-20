import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { applyMigrations } from "@/lib/migrations/runner"
import { WORK_ITEM_IDS_BACKFILL_BATCH_SIZE, assertWorkItemIdsBackfill, backfillWorkItemIds, getWorkItemIdsBackfillStatus } from "@/lib/migrations/work-item-ids-backfill"
import { replayAllMigrations } from "./helpers/replay-migrations"

/**
 * 093 / 094 through the registered runner on a throwaway schema, with legacy rows seeded first.
 * Set WORK_ITEM_IDS_DATABASE_URL to the local compass_e2e database to enable.
 */
const databaseUrl = process.env.WORK_ITEM_IDS_DATABASE_URL
const BACKFILL = "093_work_item_ids_backfill"
const RESIDUAL = "094_work_item_ids_residual_backfill"

describe.skipIf(!databaseUrl)("093/094 work item IDs backfill through the registered runner", () => {
  const schema = `work_item_backfill_test_${randomUUID().replaceAll("-", "")}`
  const pool = new Pool({ connectionString: databaseUrl, max: 4 })
  const previous = process.env.DATABASE_URL
  let owned = false
  const q = (sql: string, params: unknown[] = []) => pool.query(sql.replaceAll("$S", `"${schema}"`), params)

  const run = async (script: string) => {
    let last = await applyMigrations(pool, schema, script)
    for (let i = 0; i < 100 && last.status === 202; i++) last = await applyMigrations(pool, schema, script)
    return last
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    if (
      !["postgresql:", "postgres:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/compass_e2e" ||
      url.searchParams.has("schema")
    ) {
      throw new Error("Only isolated local compass_e2e is allowed")
    }
    process.env.DATABASE_URL = databaseUrl
    await pool.query(`CREATE SCHEMA "${schema}"`)
    owned = true
    const replay = await replayAllMigrations(pool, schema)
    expect(replay.status, JSON.stringify(await replay.json())).toBe(200)
  }, 180_000)

  afterAll(async () => {
    if (owned) await pool.query(`DROP SCHEMA "${schema}" CASCADE`)
    await pool.end()
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  })

  const seqOf = async (table: string, workspaceId: string) =>
    (await q(`SELECT seq_prefix, seq_number FROM $S.${table} WHERE workspace_id=$1 ORDER BY seq_number`, [workspaceId])).rows

  it("numbers legacy rows oldest first, fills parent workspaces, spans batches, and reruns as a no-op", async () => {
    const ws = randomUUID()
    const other = randomUUID()
    // More tasks than one batch, created out of id order: numbering must follow created_at.
    const total = WORK_ITEM_IDS_BACKFILL_BATCH_SIZE + 25
    await q(
      `INSERT INTO $S.tasks(workspace_id,title,created_at) SELECT $1,'t'||g, TIMESTAMP '2024-01-01' + (g || ' minutes')::interval FROM generate_series(1,${total}) g`,
      [ws],
    )
    await q(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'other')`, [other])
    const objective = (await q(`INSERT INTO $S.objectives(workspace_id,title) VALUES ($1,'o') RETURNING id`, [ws])).rows[0].id
    await q(`INSERT INTO $S.key_results(objective_id,title,target) VALUES ($1,'kr1',1),($1,'kr2',1)`, [objective])
    const opp = (await q(`INSERT INTO $S.opportunities(workspace_id,title) VALUES ($1,'op') RETURNING id`, [ws])).rows[0].id
    const sol = (await q(`INSERT INTO $S.solutions(workspace_id,opportunity_id,title) VALUES ($1,$2,'s') RETURNING id`, [ws, opp])).rows[0].id
    await q(`INSERT INTO $S.assumptions(solution_id,title) VALUES ($1,'a')`, [sol])

    const statusClient = await pool.connect()
    const before = await getWorkItemIdsBackfillStatus(statusClient, schema).finally(() => statusClient.release())
    expect(before.unnumbered?.tasks).toBe(total + 1)
    expect(before.nullWorkspaceId).toEqual({ key_results: 2, assumptions: 1 })

    const result = await run(BACKFILL)
    expect(result.status, JSON.stringify(await result.json())).toBe(200)

    const tasks = await seqOf("tasks", ws)
    expect(tasks.map((r) => r.seq_number)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
    expect(new Set(tasks.map((r) => r.seq_prefix))).toEqual(new Set(["TASK"]))
    const ordered = (await q(`SELECT title FROM $S.tasks WHERE workspace_id=$1 ORDER BY seq_number`, [ws])).rows.map((r) => r.title)
    expect(ordered).toEqual(Array.from({ length: total }, (_, i) => `t${i + 1}`))
    expect((await seqOf("tasks", other)).map((r) => r.seq_number)).toEqual([1])
    expect(await seqOf("key_results", ws)).toEqual([{ seq_prefix: "KR", seq_number: 1 }, { seq_prefix: "KR", seq_number: 2 }])
    expect(await seqOf("assumptions", ws)).toEqual([{ seq_prefix: "ASM", seq_number: 1 }])
    const counter = await q(`SELECT next_value FROM $S.workspace_sequences WHERE workspace_id=$1 AND entity_type='task'`, [ws])
    expect(counter.rows[0].next_value).toBe(total + 1)

    // Receipted, so the same POST is now a no-op and changes nothing.
    const again = await run(BACKFILL)
    expect(again.status).toBe(200)
    expect((await seqOf("tasks", ws)).map((r) => r.seq_number)).toEqual(Array.from({ length: total }, (_, i) => i + 1))
  }, 120_000)

  it("094 numbers rows an old instance inserted after 093, next to live allocation, keeping existing numbers", async () => {
    const ws = randomUUID()
    // Numbered by a new instance (live allocation: counter 1 -> 2, row gets 1)...
    await q(`INSERT INTO $S.workspace_sequences(workspace_id,entity_type,next_value,updated_at) VALUES ($1,'task',2,CURRENT_TIMESTAMP)`, [ws])
    await q(`INSERT INTO $S.tasks(workspace_id,title,seq_prefix,seq_number) VALUES ($1,'live1','TASK',1)`, [ws])
    // ...while an old instance inserts unnumbered rows, and the new instance keeps allocating.
    await q(`INSERT INTO $S.tasks(workspace_id,title,created_at) VALUES ($1,'late1',TIMESTAMP '2024-01-01'),($1,'late2',TIMESTAMP '2024-01-02')`, [ws])
    await q(`UPDATE $S.workspace_sequences SET next_value = next_value + 1 WHERE workspace_id=$1 AND entity_type='task'`, [ws])
    await q(`INSERT INTO $S.tasks(workspace_id,title,seq_prefix,seq_number) VALUES ($1,'live2','TASK',2)`, [ws])

    const residual = await run(RESIDUAL)
    expect(residual.status, JSON.stringify(await residual.json())).toBe(200)
    const rows = (await q(`SELECT title, seq_number FROM $S.tasks WHERE workspace_id=$1 ORDER BY seq_number`, [ws])).rows
    expect(rows).toEqual([
      { title: "live1", seq_number: 1 },
      { title: "live2", seq_number: 2 },
      { title: "late1", seq_number: 3 },
      { title: "late2", seq_number: 4 },
    ])
  }, 120_000)

  it("stays dense and unique when the backfill races live creators on the same counter", async () => {
    const ws = randomUUID()
    await q(`INSERT INTO $S.tasks(workspace_id,title) SELECT $1,'legacy'||g FROM generate_series(1,300) g`, [ws])
    // A live creator is exactly allocateOneSeq + insert in one transaction (see work-item-sequence.integration.test.ts).
    const liveCreate = async () => {
      const c = await pool.connect()
      try {
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            await c.query("BEGIN")
            const counter = await c.query(
              `INSERT INTO "${schema}".workspace_sequences(workspace_id,entity_type,next_value,updated_at) VALUES ($1,'task',2,CURRENT_TIMESTAMP)
               ON CONFLICT (workspace_id,entity_type) DO UPDATE SET next_value = workspace_sequences.next_value + 1 RETURNING next_value`,
              [ws],
            )
            await c.query(`INSERT INTO "${schema}".tasks(workspace_id,title,seq_prefix,seq_number) VALUES ($1,'live','TASK',$2)`, [ws, counter.rows[0].next_value - 1])
            await c.query("COMMIT")
            return
          } catch (error) {
            await c.query("ROLLBACK").catch(() => undefined)
            if ((error as { code?: string }).code !== "40001") throw error
          }
        }
      } finally {
        c.release()
      }
    }
    const backfillClient = await pool.connect()
    try {
      await Promise.all([
        backfillWorkItemIds(backfillClient, schema, []),
        ...Array.from({ length: 25 }, () => liveCreate()),
      ])
      await backfillWorkItemIds(backfillClient, schema, []) // pick up anything a live insert raced past
      await assertWorkItemIdsBackfill(backfillClient, schema, "race-test")
    } finally {
      backfillClient.release()
    }
    const numbers = (await seqOf("tasks", ws)).map((r) => r.seq_number)
    expect(numbers).toEqual(Array.from({ length: 325 }, (_, i) => i + 1))
  }, 120_000)

  it("refuses a key result whose objective is gone and a row with no workspace; numberable rows still get numbers", async () => {
    const ws = randomUUID()
    await q(`INSERT INTO $S.key_results(objective_id,title,target) VALUES ($1,'orphan',1)`, [randomUUID()])
    await q(`INSERT INTO $S.tasks(workspace_id,title) VALUES ($1,'ok')`, [ws])
    const client = await pool.connect()
    try {
      const log: string[] = []
      await backfillWorkItemIds(client, schema, log)
      await expect(assertWorkItemIdsBackfill(client, schema)).rejects.toThrow(/1 key_results rows still have NULL workspace_id/)
      expect((await seqOf("tasks", ws)).map((r) => r.seq_number)).toEqual([1])

      await q(`DELETE FROM $S.key_results WHERE title='orphan'`)
      // INTENTIONAL NULL workspaceId: a legacy objective with no workspace cannot be numbered, and the postcondition must refuse it.
      await q(`INSERT INTO $S.objectives(title) VALUES ('no workspace')`)
      await expect(assertWorkItemIdsBackfill(client, schema)).rejects.toThrow(/objectives rows have no work item number/)
      await q(`DELETE FROM $S.objectives WHERE title='no workspace'`)
      await expect(assertWorkItemIdsBackfill(client, schema)).resolves.toBeUndefined()

      // A counter that lags the highest number in use is refused: the next create would collide.
      await q(`UPDATE $S.workspace_sequences SET next_value = 1 WHERE workspace_id=$1 AND entity_type='task'`, [ws])
      await expect(assertWorkItemIdsBackfill(client, schema)).rejects.toThrow(/counter postcondition failed/)
    } finally {
      client.release()
    }
  }, 120_000)
})
