import type { PoolClient } from "pg"
import { getEntityLinksConversationStatus } from "@/lib/migrations/entity-links-conversation-backfill"
import { getEntityLinksReadParityStatus } from "@/lib/migrations/entity-links-read-parity"
import { getEntityLinksTaskLinkMoveStatus } from "@/lib/migrations/entity-links-task-link-move"
import { ALL_LEGACY_RELATIONS, LEGACY_LINK_TABLES, LEGACY_POINTER_COLUMN, LEGACY_POINTER_RELATION, presentLegacyRelations, type LegacyRelation } from "@/lib/migrations/legacy-link-relations"
import { WorkspaceIdBackfillRefusal } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * THE POINT OF NO RETURN of the entity_links cleanup: drops the four frozen legacy link tables (task_links, artifact_links,
 * opportunity_objective_links, solution_key_result_links) and the column opportunities.linked_key_result_id. entity_links has been the only
 * store since #547 and migration 115 moved the last two task-link kinds, so nothing reads or writes any of them.
 *
 * EXPLICIT-ONLY, NEVER UNTARGETED. An untargeted POST skips it. POST it by name, after the code that no longer names the tables is deployed
 * (a still-running old deployment would error on a missing table) and after the operator has taken the backup of
 * docs/maintenance/entity-links-legacy-drop.md. A dropped table cannot be restored by this application; the backup is the only way back.
 *
 * NO DDL IN THE .sql FILE. The statements live here so that NOTHING runs before the preflight has passed.
 *
 * PREFLIGHT (read-only; any failure throws a refusal and drops nothing). It fails closed unless ALL of:
 *   1. 091 (entity_links) and 115 (the task-link move) have a finished receipt;
 *   2. for every legacy source that still exists, EVERY LIVE legacy pair is present in entity_links (parity `onlyLegacy` = 0). Extra
 *      entity_links rows are fine (links made after the cleanup have no legacy twin). A legacy row whose endpoint is gone is not live, so it
 *      is not required to have a twin (no reader could ever show it); it is dropped with the table and survives only in the backup;
 *   3. entityLinksTaskLinkMove.unmoved = 0 (every consistent COMMENT / AGENT_CONVERSATION task link has its TASK_CREATED_FROM row);
 *   4. every consistent AGENT_CONVERSATION task link has its CONVERSATION_CREATED row (migration 113 derives from task_links too).
 *
 * THE DROP. One DDL statement per autocommit statement (DSQL allows one DDL per transaction), each IF EXISTS, so a half-finished run resumes:
 * the tables first, the column last. DROP COLUMN is supported by Aurora DSQL (checked against the ALTER TABLE reference: "DROP [ COLUMN ]
 * [ IF EXISTS ]", primary-key columns excepted; the column is hidden, not physically removed, and counts against the 1,600 lifetime column
 * limit). Plain Postgres drops the column's index and constraints with it.
 *
 * POSTCONDITION (before the receipt): none of the five legacy relations exists and entity_links is still there.
 */
export const ENTITY_LINKS_LEGACY_DROP_MIGRATION = "116_entity_links_drop_legacy_tables"

const refuse = (message: string) => new WorkspaceIdBackfillRefusal(`${ENTITY_LINKS_LEGACY_DROP_MIGRATION}: ${message}`)

const FINISHED_RECEIPT_SQL = (schema: string) => `SELECT count(*)::text AS n FROM "${schema}"._prisma_migrations WHERE migration_name = $1 AND finished_at IS NOT NULL`
const receiptExists = async (client: PoolClient, schema: string, name: string) => Number((await client.query<{ n: string }>(FINISHED_RECEIPT_SQL(schema), [name])).rows[0]?.n ?? "0") > 0

export type LegacyDropPreflight = {
  /** Reasons the drop must be refused. Empty = safe to drop. */
  blockers: string[]
  /** Informational lines that do not block (for example origin drift, which is reported, not refused). */
  notes: string[]
  present: LegacyRelation[]
}

/** Read-only evaluation shared by the POST (which throws on a blocker) and the GET status (which reports it). */
export async function evaluateLegacyDropPreflight(client: PoolClient, schema: string): Promise<LegacyDropPreflight> {
  const blockers: string[] = []
  const notes: string[] = []
  const present = await presentLegacyRelations(client, schema)
  const out = (): LegacyDropPreflight => ({ blockers, notes, present: ALL_LEGACY_RELATIONS.filter((relation) => present.has(relation)) })

  for (const name of ["091_entity_links", "115_entity_links_task_link_move"]) {
    if (!(await receiptExists(client, schema, name))) blockers.push(`migration ${name} has no finished receipt`)
  }
  // Nothing left to drop: only the receipt checks above matter (a rerun after a finished drop).
  if (present.size === 0) return out()

  const parity = await getEntityLinksReadParityStatus(client, schema)
  for (const [name, entry] of Object.entries(parity.families)) {
    if (entry.legacyDropped) continue
    if (entry.onlyLegacy > 0) {
      const more = entry.onlyLegacy > entry.ids.onlyLegacy.length ? ` ... and ${entry.onlyLegacy - entry.ids.onlyLegacy.length} more` : ""
      blockers.push(`parity: ${entry.onlyLegacy} live ${name} legacy row(s) have no entity_links row (legacy ids: ${entry.ids.onlyLegacy.join(", ")}${more})`)
    }
    if (entry.originDrift > 0) notes.push(`${name}: ${entry.originDrift} pair(s) exist in both stores with a different origin (reported, not blocking)`)
  }

  if (present.has("task_links")) {
    const move = await getEntityLinksTaskLinkMoveStatus(client, schema)
    if (move.unmoved !== 0) blockers.push(`entityLinksTaskLinkMove.unmoved = ${move.unmoved}, must be 0 (POST 115_entity_links_task_link_move again)`)
    const conversation = await getEntityLinksConversationStatus(client, schema)
    if (conversation.unmatched !== 0) blockers.push(`entityLinksConversationBackfill.unmatched = ${conversation.unmatched}, must be 0 (POST 113_entity_links_backfill_conversation)`)
  }
  return out()
}

/** Throws a refusal (nothing dropped) unless the preflight is clean. A preflight that cannot be evaluated also refuses. */
export async function assertLegacyDropPreflight(client: PoolClient, schema: string): Promise<LegacyDropPreflight> {
  let result: LegacyDropPreflight
  try {
    result = await evaluateLegacyDropPreflight(client, schema)
  } catch (error) {
    throw refuse(`preflight could not be evaluated, nothing was dropped: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (result.blockers.length > 0) throw refuse(`preflight refused, NOTHING was dropped:\n  - ${result.blockers.join("\n  - ")}`)
  return result
}

/** Runs the preflight, then drops what is still there. Idempotent and resumable. Returns the relations it dropped. */
export async function dropLegacyLinkRelations(client: PoolClient, schema: string, log: string[]): Promise<LegacyRelation[]> {
  const preflight = await assertLegacyDropPreflight(client, schema)
  for (const note of preflight.notes) log.push(`  ~ ${note}`)
  log.push(`  ✓ preflight clean (legacy relations present: ${preflight.present.length === 0 ? "none" : preflight.present.join(", ")})`)

  const dropped: LegacyRelation[] = []
  const present = new Set<LegacyRelation>(preflight.present)
  for (const table of LEGACY_LINK_TABLES) {
    if (!present.has(table)) continue
    // Autocommit: each statement is its own transaction, which is what DSQL's one-DDL-per-transaction rule needs.
    await client.query(`DROP TABLE IF EXISTS "${schema}"."${table}"`)
    log.push(`  ✓ dropped table ${table}`)
    dropped.push(table)
  }
  if (present.has(LEGACY_POINTER_RELATION)) {
    await client.query(`ALTER TABLE "${schema}"."opportunities" DROP COLUMN IF EXISTS "${LEGACY_POINTER_COLUMN}"`)
    log.push(`  ✓ dropped column opportunities.${LEGACY_POINTER_COLUMN}`)
    dropped.push(LEGACY_POINTER_RELATION)
  }
  return dropped
}

/** Before the receipt: all five relations are gone and the surviving store is intact. */
export async function assertLegacyDropped(client: PoolClient, schema: string) {
  const present = await presentLegacyRelations(client, schema)
  if (present.size > 0) throw refuse(`postcondition failed: still present after the drop: ${[...present].join(", ")}`)
  const store = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ('entity_links', 'opportunities', 'tasks', 'artifacts')`, [schema])
  if (Number(store.rows[0]?.n ?? "0") !== 4) throw refuse("postcondition failed: entity_links, opportunities, tasks or artifacts is missing")
}

// ── Read-only status for GET /api/admin/migrate ────────────────────────────────────────────────────────────────────

export type EntityLinksLegacyDropStatus = {
  /** The legacy relations that still exist. Empty once 116 ran. */
  present: LegacyRelation[]
  dropped: boolean
  /** The preflight verdict the POST would reach right now. */
  ready: boolean
  blockers: string[]
  notes: string[]
}

/** Counts and ids only. Costs one read-parity pass (see getEntityLinksReadParityStatus), so poll sparingly. */
export async function getEntityLinksLegacyDropStatus(client: PoolClient, schema: string): Promise<EntityLinksLegacyDropStatus> {
  const preflight = await evaluateLegacyDropPreflight(client, schema)
  return { present: preflight.present, dropped: preflight.present.length === 0, ready: preflight.blockers.length === 0, blockers: preflight.blockers, notes: preflight.notes }
}
