import type { PoolClient } from "pg"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of RM-19 (agent conversations <-> Opportunities, Solutions, Tasks) on the generic entity_links table. No DDL: 091 created
 * entity_links, 027 created task_links.
 *
 *   CONVERSATION_CREATED <- task_links WHERE linked_type = 'AGENT_CONVERSATION'
 *       (conversation AGENT_CONVERSATION -> task TASK), origin MIGRATION, source AGENT, created_at COPIED, created_by_id NULL.
 *
 * Every task the agent made with TaskCreate carries that legacy link (lib/agent-task-tools.ts). task_links STAYS the source of truth for the
 * plan card and the task screen: nothing reads it differently and nothing is deleted. This only gives those tasks the same
 * conversation link that the new tool hook writes from now on, so the Conversations section and the Linked objects card cover history.
 *
 * EXPLICIT-ONLY (like 095-098): POST it by name after the code that writes the new link types is deployed, so nothing is created
 * unlinked while it runs. Idempotent and resumable (KEYSET-paged by task_links.id, committed batches of 500; anti-join on the unique pair
 * index, no ON CONFLICT, which is unproven against DSQL's async unique index; a unique-index race with the live hook re-selects, bounded).
 *
 * Only CONSISTENT rows are linked: the conversation and the task exist and share one workspace. Every other row is left exactly as it is and
 * REPORTED (counts plus capped ids): `dangling` (conversation or task gone) and `crossWorkspace`.
 * A CONVERSATION_MENTIONS row for a pair that now has a CREATED link is removed (the hook never keeps both).
 *
 * Before the receipt the postconditions prove: zero unmatched consistent legacy rows, zero duplicate pairs, no pair holding both link types,
 * and every written row's workspace_id equals its conversation's and its task's.
 */
export const ENTITY_LINKS_CONVERSATION_BACKFILL_MIGRATION = "113_entity_links_backfill_conversation"

export const CONVERSATION_CREATED_KEY = "CONVERSATION_CREATED"
export const CONVERSATION_MENTIONS_KEY = "CONVERSATION_MENTIONS"
export const ENTITY_LINKS_CONVERSATION_BACKFILL_BATCH_SIZE = 500
const REPORTED_ID_CAP = 50
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

type Sleep = (ms: number) => Promise<void>
const num = (value: unknown) => Number(value ?? "0")
const count = async (client: PoolClient, sql: string, params: unknown[] = []) => num((await client.query<{ n: string }>(sql, params)).rows[0]?.n)
const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_CONVERSATION_BACKFILL_MIGRATION}: ${message}`)

export type ConversationQuarantineClass = "dangling" | "crossWorkspace"
export type ConversationLinksQuarantine = Record<ConversationQuarantineClass, { count: number; ids: string[] }>

/** Legacy rows with their conversation and task (LEFT JOINs: a missing endpoint is a class, not a vanished row). */
const source = (s: string) => `"${s}"."task_links" AS l
         LEFT JOIN "${s}"."agent_conversations" AS c ON c.id = l.linked_id
         LEFT JOIN "${s}"."tasks" AS t ON t.id = l.task_id`
const classOf = `CASE
           WHEN c.id IS NULL OR t.id IS NULL THEN 'dangling'
           WHEN c.workspace_id IS NULL OR t.workspace_id IS NULL OR c.workspace_id <> t.workspace_id THEN 'crossWorkspace'
           ELSE 'ok' END`
const mirrorJoin = (s: string) => `LEFT JOIN "${s}"."entity_links" AS e ON e.from_id = l.linked_id AND e.link_type = '${CONVERSATION_CREATED_KEY}' AND e.to_id = l.task_id`

export async function assertEntityLinksConversationPreconditions(client: PoolClient, schema: string) {
  const receipt = await count(client, `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`, ["091_entity_links"])
  if (receipt === 0) throw refuse("precondition failed: 091_entity_links is not applied. Apply it first; nothing was changed.")
  const present = await client.query<{ table_name: string }>(
    `SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = $1 AND (
       (table_name = 'entity_links' AND column_name = 'link_type') OR (table_name = 'task_links' AND column_name = 'linked_type')
       OR (table_name = 'tasks' AND column_name = 'workspace_id') OR (table_name = 'agent_conversations' AND column_name = 'workspace_id'))`,
    [schema],
  )
  if (present.rows.length !== 4) throw refuse("precondition failed: entity_links, task_links, tasks or agent_conversations is missing a column the backfill needs. Nothing was changed.")
}

/** Keyset-paged batches; the cursor moves past a batch whatever `apply` did, so no batch can loop. `retry` re-runs a batch (a unique-index race), bounded. */
async function pagedBatches(select: (after: string) => Promise<{ id: string }[]>, apply: (ids: string[]) => Promise<number | "retry">): Promise<number> {
  let total = 0
  let after = NIL_UUID
  let retries = 0
  while (true) {
    const rows = await select(after)
    if (rows.length === 0) return total
    const changed = await apply(rows.map((row) => row.id))
    if (changed === "retry") {
      if ((retries += 1) > 5) throw refuse("a live writer kept racing the same batch of inserts; re-POST to resume")
      continue
    }
    retries = 0
    total += changed
    after = rows[rows.length - 1].id
  }
}

async function insertMissingRows(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  return pagedBatches(
    async (after) =>
      (await client.query<{ id: string }>(
        `SELECT l.id AS id FROM ${source(schema)} ${mirrorJoin(schema)}
         WHERE l.linked_type = 'AGENT_CONVERSATION' AND e.id IS NULL AND l.id > $1::uuid AND (${classOf}) = 'ok'
         ORDER BY l.id LIMIT $2`,
        [after, ENTITY_LINKS_CONVERSATION_BACKFILL_BATCH_SIZE],
      )).rows,
    async (ids) => {
      try {
        const result = await withOccRetry(
          () => client.query(
            `INSERT INTO "${schema}"."entity_links" (workspace_id, link_type, from_type, from_id, to_type, to_id, origin, source, created_by_id, created_at, updated_at)
             SELECT c.workspace_id, '${CONVERSATION_CREATED_KEY}', 'AGENT_CONVERSATION', l.linked_id, 'TASK', l.task_id, 'MIGRATION', 'AGENT', NULL, l.created_at, CURRENT_TIMESTAMP
             FROM ${source(schema)}
             WHERE l.id = ANY($1::uuid[]) AND l.linked_type = 'AGENT_CONVERSATION' AND (${classOf}) = 'ok'`,
            [ids],
          ),
          sleep,
        )
        return result.rowCount ?? 0
      } catch (error) {
        // The live hook wrote one of these pairs between the select and the insert: the unique pair index refused the whole batch
        // (nothing was written), so re-select; the anti-join now excludes the winner.
        if ((error as { code?: string } | null)?.code === "23505") return "retry"
        throw error
      }
    },
  )
}

/** MENTIONS rows for a pair that has a legacy link (so a CREATED row): the hook never keeps both. */
async function removeShadowedMentions(client: PoolClient, schema: string, sleep?: Sleep): Promise<number> {
  const shadowed = `e.link_type = '${CONVERSATION_MENTIONS_KEY}' AND EXISTS (SELECT 1 FROM "${schema}"."task_links" AS l WHERE l.linked_type = 'AGENT_CONVERSATION' AND l.linked_id = e.from_id AND l.task_id = e.to_id)`
  return pagedBatches(
    async (after) =>
      (await client.query<{ id: string }>(`SELECT e.id AS id FROM "${schema}"."entity_links" AS e WHERE e.id > $1::uuid AND ${shadowed} ORDER BY e.id LIMIT $2`, [after, ENTITY_LINKS_CONVERSATION_BACKFILL_BATCH_SIZE])).rows,
    async (ids) => (await withOccRetry(() => client.query(`DELETE FROM "${schema}"."entity_links" AS e WHERE e.id = ANY($1::uuid[]) AND ${shadowed}`, [ids]), sleep)).rowCount ?? 0,
  )
}

/** The legacy rows that are NOT linked, by class, with up to REPORTED_ID_CAP task_links ids each. Read-only. */
export async function findQuarantinedConversationLinks(client: PoolClient, schema: string): Promise<ConversationLinksQuarantine> {
  const out: ConversationLinksQuarantine = { dangling: { count: 0, ids: [] }, crossWorkspace: { count: 0, ids: [] } }
  for (const cls of ["dangling", "crossWorkspace"] as const) {
    const where = `l.linked_type = 'AGENT_CONVERSATION' AND (${classOf}) = '${cls}'`
    out[cls].count = await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} WHERE ${where}`)
    if (out[cls].count > 0) out[cls].ids = (await client.query<{ id: string }>(`SELECT l.id AS id FROM ${source(schema)} WHERE ${where} ORDER BY l.id LIMIT ${REPORTED_ID_CAP}`)).rows.map((row) => row.id)
  }
  return out
}

export async function backfillEntityLinksConversation(
  client: PoolClient,
  schema: string,
  log: string[],
  sleep?: Sleep,
): Promise<{ inserted: number; mentionsRemoved: number; quarantined: ConversationLinksQuarantine }> {
  await assertEntityLinksConversationPreconditions(client, schema)
  const inserted = await insertMissingRows(client, schema, sleep)
  const mentionsRemoved = await removeShadowedMentions(client, schema, sleep)
  log.push(`  ✓ ${CONVERSATION_CREATED_KEY}: inserted ${inserted}, removed ${mentionsRemoved} shadowed ${CONVERSATION_MENTIONS_KEY} rows`)
  const quarantined = await findQuarantinedConversationLinks(client, schema)
  for (const cls of ["dangling", "crossWorkspace"] as const) {
    const entry = quarantined[cls]
    if (entry.count > 0) {
      const more = entry.count > entry.ids.length ? ` … and ${entry.count - entry.ids.length} more` : ""
      log.push(`  ! quarantined ${entry.count} task_links row(s) of class ${cls}, left unlinked and untouched (task_links ids): ${entry.ids.join(", ")}${more}`)
    }
  }
  return { inserted, mentionsRemoved, quarantined }
}

/** All of these must hold before the receipt is recorded (each throws a refusal, so the attempt stays unfinished and a re-POST resumes). */
export async function assertEntityLinksConversationBackfill(client: PoolClient, schema: string) {
  const unmatched = await count(
    client,
    `SELECT count(*)::text AS n FROM ${source(schema)} ${mirrorJoin(schema)}
       WHERE l.linked_type = 'AGENT_CONVERSATION' AND (${classOf}) = 'ok' AND (e.id IS NULL OR e.workspace_id <> c.workspace_id)`,
  )
  if (unmatched !== 0) throw refuse(`coverage postcondition failed: ${unmatched} consistent AGENT_CONVERSATION task links have no matching ${CONVERSATION_CREATED_KEY} row`)

  const duplicates = await count(
    client,
    `SELECT count(*)::text AS n FROM (SELECT from_id FROM "${schema}"."entity_links" WHERE link_type IN ('${CONVERSATION_CREATED_KEY}', '${CONVERSATION_MENTIONS_KEY}') GROUP BY from_id, link_type, to_id HAVING count(*) > 1) AS dup`,
  )
  if (duplicates !== 0) throw refuse(`uniqueness postcondition failed: ${duplicates} duplicate (from, type, to) pairs`)

  const both = await count(
    client,
    `SELECT count(*)::text AS n FROM "${schema}"."entity_links" AS m
       WHERE m.link_type = '${CONVERSATION_MENTIONS_KEY}' AND EXISTS (SELECT 1 FROM "${schema}"."task_links" AS l WHERE l.linked_type = 'AGENT_CONVERSATION' AND l.linked_id = m.from_id AND l.task_id = m.to_id)`,
  )
  if (both !== 0) throw refuse(`exclusivity postcondition failed: ${both} pairs hold a ${CONVERSATION_MENTIONS_KEY} row beside their ${CONVERSATION_CREATED_KEY} row`)
}

export type EntityLinksConversationStatus = {
  legacyConversationLinks: number
  linkedCreated: number
  /** Consistent legacy rows the backfill would still insert. */
  unmatched: number
  quarantined: ConversationLinksQuarantine
}

/** Counts and capped ids only. Throws if a table is missing; the caller turns that into an error field. */
export async function getEntityLinksConversationStatus(client: PoolClient, schema: string): Promise<EntityLinksConversationStatus> {
  return {
    legacyConversationLinks: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."task_links" WHERE linked_type = 'AGENT_CONVERSATION'`),
    linkedCreated: await count(client, `SELECT count(*)::text AS n FROM "${schema}"."entity_links" WHERE link_type = '${CONVERSATION_CREATED_KEY}'`),
    unmatched: await count(client, `SELECT count(*)::text AS n FROM ${source(schema)} ${mirrorJoin(schema)} WHERE l.linked_type = 'AGENT_CONVERSATION' AND e.id IS NULL AND (${classOf}) = 'ok'`),
    quarantined: await findQuarantinedConversationLinks(client, schema),
  }
}
