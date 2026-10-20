import { Pool } from "pg"
import { applyMigrations, partitionPendingMigrations } from "@/lib/migrations/runner"
import type { NextResponse } from "next/server"

/**
 * Replays every migration one at a time. A single untargeted run cannot be used on a fresh
 * schema: 042 (the 039 repair) is an alternative of 039, so it is already settled in any real
 * environment, but a from-scratch run still attempts it after 040 has added source_fingerprint and
 * its fixed 061-column fingerprint refuses. Explicit-only migrations and the 093/094 data migrations are left for their own tests (they need legacy rows seeded first).
 */
const SKIP_IN_REPLAY = new Set(["042_native_decision_gates_repair", "069_workspace_id_residual_backfill", "072_typed_links_residual_backfill", "093_work_item_ids_backfill", "094_work_item_ids_residual_backfill", "095_entity_links_backfill_opportunity", "097_entity_links_backfill_task"])
export async function replayAllMigrations(pool: Pool, schema: string): Promise<NextResponse> {
  let last!: NextResponse
  for (const migration of partitionPendingMigrations(schema, new Set()).pending) {
    if (SKIP_IN_REPLAY.has(migration.name)) continue
    for (let attempt = 0; attempt < 100; attempt++) {
      last = await applyMigrations(pool, schema, migration.name)
      if (last.status !== 202) break
    }
    if (last.status !== 200) return last
  }
  return last
}
