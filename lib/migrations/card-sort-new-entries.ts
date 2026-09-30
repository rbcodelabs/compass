import type { PoolClient } from "pg"

/**
 * Postcondition assertion for migration 068_card_sort_new_entries.
 *
 * Same contract as assertCardSortRoundsMigration: the runner only writes a
 * finished receipt once this passes, so a half-applied schema stays visible as
 * an unfinished attempt instead of being recorded as done.
 *
 * `status` must be NOT NULL with a default: the accept/reject paths claim an
 * entry with `updateMany({ where: { status: "PENDING" } })`, which only means
 * "still unresolved" if every row actually carries a status.
 */

export const CARD_SORT_NEW_ENTRIES_INDEXES = ["idx_card_sort_new_entries_round_status"] as const

const REQUIRED_COLUMNS = [
  "id",
  "round_id",
  "user_id",
  "title",
  "description",
  "suggested_value",
  "status",
  "accepted_object_id",
  "resolved_by_id",
  "resolved_at",
  "resolution_note",
  "created_at",
  "updated_at",
] as const

type ColumnRow = { column_name: string; is_nullable: string; column_default: string | null }

export async function assertCardSortNewEntriesMigration(client: PoolClient, schema: string) {
  const columns = await client.query<ColumnRow>(
    "SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='card_sort_new_entries'",
    [schema],
  )
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]))
  const missing = REQUIRED_COLUMNS.filter((column) => !byName.has(column))
  if (missing.length > 0) {
    throw new Error(
      `Migration 068_card_sort_new_entries postcondition failed: card_sort_new_entries is missing column(s) ${missing.join(", ")}.`,
    )
  }

  const status = byName.get("status")!
  if (status.is_nullable !== "NO" || status.column_default === null) {
    throw new Error(
      "Migration 068_card_sort_new_entries postcondition failed: card_sort_new_entries.status must be NOT NULL with a default, or 'still PENDING' stops being a reliable claim.",
    )
  }

  const indexes = await client.query<{ name: string; valid: boolean }>(
    "SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname = ANY($2::text[])",
    [schema, [...CARD_SORT_NEW_ENTRIES_INDEXES]],
  )
  const unhealthy = CARD_SORT_NEW_ENTRIES_INDEXES.filter(
    (name) => !indexes.rows.some((row) => row.name === name && row.valid),
  )
  if (unhealthy.length > 0) {
    throw new Error(
      `Migration 068_card_sort_new_entries postcondition failed: index(es) missing or not valid: ${unhealthy.join(", ")}.`,
    )
  }
}
