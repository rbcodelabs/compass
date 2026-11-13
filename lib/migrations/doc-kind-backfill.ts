// Red-phase stub: real implementation lands in the next commit.
import type { PoolClient } from "pg"

export const DOC_KIND_BACKFILL_MIGRATION = ""

export async function backfillDocKinds(_client: PoolClient, _schema: string, _log: string[] = [], _options: { batchSize?: number } = {}): Promise<number> {
  return 0
}

export async function assertDocKindBackfill(_client: PoolClient, _schema: string): Promise<void> {
  return
}
