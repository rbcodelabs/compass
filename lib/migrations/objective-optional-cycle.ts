import type { PoolClient } from "pg"

export const OBJECTIVE_OPTIONAL_CYCLE_MIGRATION = "069_objective_optional_cycle"

/**
 * Postcondition for 069. Runs before the migration receipt is recorded, so an
 * attempt where the DROP NOT NULL did not take effect stays unfinished and the
 * next POST retries it. Existing rows are deliberately not inspected: the
 * migration changes no data.
 */
export async function assertObjectiveCycleIdNullable(client: PoolClient, schema: string) {
  const column = await client.query<{ is_nullable: string }>(
    "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'objectives' AND column_name = 'cycle_id'",
    [schema],
  )
  if (column.rows.length !== 1) {
    throw new Error(`${OBJECTIVE_OPTIONAL_CYCLE_MIGRATION}: column postcondition failed: objectives.cycle_id missing`)
  }
  if (column.rows[0].is_nullable !== "YES") {
    throw new Error(`${OBJECTIVE_OPTIONAL_CYCLE_MIGRATION}: nullability postcondition failed: objectives.cycle_id is still NOT NULL`)
  }
}
