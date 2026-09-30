import type { PoolClient } from "pg"

/**
 * Postcondition assertion for migration 067_card_sort_rounds.
 *
 * Mirrors assertSharedFieldOptionSetsMigration: the runner only writes a
 * finished receipt once this passes, so a half-applied schema stays visible as
 * an unfinished attempt instead of being recorded as done.
 *
 * Two checks here are load-bearing rather than cosmetic:
 *
 *  1. `card_sort_proposals.from_value` must be NULLABLE. It is the snapshot of
 *     the official value at proposal time, and NULL is the only honest way to
 *     record "this object had no value for the factor yet" — a real state for
 *     any factor with unset objects. A NOT NULL column here would force either
 *     a sentinel string (indistinguishable from a genuine option value) or
 *     dropping the proposal outright.
 *
 *  2. The UNIQUE index on (round_id, user_id, object_id) must exist AND be
 *     valid. It is the latest-wins constraint — one live proposal per person per
 *     object per round — and the upsert path uses it as its conflict target. If
 *     it is missing or invalid, a participant changing their mind silently
 *     appends a second opinion and every tally double-counts them. Checking
 *     `indisunique` as well as `indisvalid` is deliberate: an index built
 *     non-unique would satisfy a name-only check while losing the entire
 *     guarantee.
 */

export const CARD_SORT_INDEXES = [
  "idx_card_sort_rounds_workspace_state",
  "idx_card_sort_proposals_round_user_object",
  "idx_card_sort_proposals_round_object",
] as const

/** The one index whose uniqueness is a correctness constraint, not a speed-up. */
const CARD_SORT_UNIQUE_INDEX = "idx_card_sort_proposals_round_user_object"

const REQUIRED_COLUMNS = [
  "card_sort_rounds.id",
  "card_sort_rounds.workspace_id",
  "card_sort_rounds.name",
  "card_sort_rounds.object_type",
  "card_sort_rounds.field_definition_id",
  "card_sort_rounds.state",
  "card_sort_rounds.created_by_id",
  "card_sort_rounds.created_at",
  "card_sort_rounds.updated_at",
  "card_sort_rounds.revealed_at",
  "card_sort_rounds.closed_at",
  "card_sort_proposals.id",
  "card_sort_proposals.round_id",
  "card_sort_proposals.user_id",
  "card_sort_proposals.object_id",
  "card_sort_proposals.proposed_value",
  "card_sort_proposals.from_value",
  "card_sort_proposals.rationale",
  "card_sort_proposals.created_at",
  "card_sort_proposals.updated_at",
] as const

type ColumnRow = {
  table_name: string
  column_name: string
  is_nullable: string
  column_default: string | null
}

export async function assertCardSortRoundsMigration(client: PoolClient, schema: string) {
  const columns = await client.query<ColumnRow>(
    "SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name = ANY($2::text[])",
    [schema, ["card_sort_rounds", "card_sort_proposals"]],
  )
  const byName = new Map(columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]))
  const missing = REQUIRED_COLUMNS.filter((column) => !byName.has(column))
  if (missing.length > 0) {
    throw new Error(`Migration 065 postcondition failed: missing column(s) ${missing.join(", ")}.`)
  }

  const fromValue = byName.get("card_sort_proposals.from_value")!
  if (fromValue.is_nullable !== "YES") {
    throw new Error(
      "Migration 065 postcondition failed: card_sort_proposals.from_value must be nullable so a proposal on an object with no current value can record that honestly.",
    )
  }

  const indexes = await client.query<{ name: string; valid: boolean; unique: boolean }>(
    "SELECT c.relname AS name, i.indisvalid AS valid, i.indisunique AS unique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])",
    [schema, [...CARD_SORT_INDEXES]],
  )
  const unhealthy = CARD_SORT_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.valid),
  )
  if (unhealthy.length > 0) {
    throw new Error(
      `Migration 065 postcondition failed: index(es) missing or not valid: ${unhealthy.join(", ")}.`,
    )
  }

  const latestWins = indexes.rows.find((row) => row.name === CARD_SORT_UNIQUE_INDEX)
  if (!latestWins?.unique) {
    throw new Error(
      `Migration 065 postcondition failed: ${CARD_SORT_UNIQUE_INDEX} exists but is not UNIQUE, so one person could hold several live proposals for the same object and every tally would double-count them.`,
    )
  }
}
