import type { PoolClient } from "pg"
import { classifyDocKind } from "@/lib/doc-kind-backfill"
import type { DocKind } from "@/lib/doc-kinds"
import { DOC_KIND_MIGRATION } from "@/lib/migrations/doc-kind"
import { WorkspaceIdBackfillRefusal, withOccRetry } from "@/lib/migrations/workspace-id-on-solution-objective"

/**
 * Data half of the Docs library: gives existing docs a `kind` from their title and parent page (the pure rules are in
 * lib/doc-kind-backfill.ts). No DDL: 117 added the column. EXPLICIT-ONLY: POST it by name, never untargeted.
 *
 * Idempotent and resumable: only rows whose kind IS NULL are read or written (a kind set by hand or through write_doc is never
 * overwritten), the walk is in id order so rows the classifier cannot place do not loop forever, each batch is its own short statement,
 * and a crash simply continues. updated_at is deliberately not touched.
 */
export const DOC_KIND_BACKFILL_MIGRATION = "118_doc_kind_backfill"

/** DSQL caps a write transaction at 3,000 modified rows; stay far below it. */
export const DOC_KIND_BACKFILL_BATCH_SIZE = 500

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

type Sleep = (ms: number) => Promise<void>
type Candidate = { id: string; title: string; parent_title: string | null }

async function assertKindColumnExists(client: PoolClient, schema: string) {
  const column = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='docs' AND column_name='kind'", [schema])
  if (column.rows.length === 0) throw new WorkspaceIdBackfillRefusal(`${DOC_KIND_BACKFILL_MIGRATION}: apply ${DOC_KIND_MIGRATION} first`)
}

/**
 * One page of docs that still have no kind, after `afterId`, with their parent page's title. The parent must be in the same workspace: a
 * dangling or foreign parent_id reads as "no parent", so a title rule can still apply but a parent rule cannot.
 */
async function nextCandidates(client: PoolClient, schema: string, afterId: string, limit: number): Promise<Candidate[]> {
  const page = await client.query<Candidate>(
    `SELECT d.id, d.title, p.title AS parent_title
       FROM "${schema}"."docs" AS d
       LEFT JOIN "${schema}"."docs" AS p ON p.id = d.parent_id AND p.workspace_id = d.workspace_id
      WHERE d.kind IS NULL AND d.id > $1::uuid
      ORDER BY d.id
      LIMIT $2`,
    [afterId, limit],
  )
  return page.rows
}

/** Sets each classified doc's kind, only where it is still NULL. Returns the rows actually changed. */
export async function backfillDocKinds(
  client: PoolClient,
  schema: string,
  log: string[] = [],
  options: { batchSize?: number; sleep?: Sleep } = {},
): Promise<number> {
  await assertKindColumnExists(client, schema)
  const batchSize = options.batchSize ?? DOC_KIND_BACKFILL_BATCH_SIZE
  const perKind = new Map<DocKind, number>()
  let total = 0
  let cursor = NIL_UUID
  while (true) {
    const batch = await nextCandidates(client, schema, cursor, batchSize)
    if (batch.length === 0) break
    cursor = batch[batch.length - 1].id
    const idsByKind = new Map<DocKind, string[]>()
    for (const row of batch) {
      const kind = classifyDocKind({ title: row.title, parentTitle: row.parent_title })
      if (!kind) continue
      idsByKind.set(kind, [...(idsByKind.get(kind) ?? []), row.id])
    }
    for (const [kind, ids] of idsByKind) {
      const result = await withOccRetry(
        () => client.query(`UPDATE "${schema}"."docs" SET kind = $1 WHERE id = ANY($2::uuid[]) AND kind IS NULL`, [kind, ids]),
        options.sleep,
      )
      const changed = result.rowCount ?? 0
      total += changed
      perKind.set(kind, (perKind.get(kind) ?? 0) + changed)
    }
  }
  const summary = [...perKind].map(([kind, count]) => `${kind}=${count}`).join(", ")
  log.push(`  ✓ classified ${total} docs${summary ? ` (${summary})` : ""}; docs the rules do not place stay unset`)
  return total
}

/**
 * Postcondition run before the completion receipt: the column exists and no doc the classifier would classify still has a NULL kind.
 * Fails closed, so an unfinished or blocked backfill never gets a receipt (re-POST resumes).
 */
export async function assertDocKindBackfill(client: PoolClient, schema: string) {
  await assertKindColumnExists(client, schema)
  let cursor = NIL_UUID
  const unclassified: string[] = []
  let count = 0
  while (true) {
    const batch = await nextCandidates(client, schema, cursor, DOC_KIND_BACKFILL_BATCH_SIZE)
    if (batch.length === 0) break
    cursor = batch[batch.length - 1].id
    for (const row of batch) {
      if (!classifyDocKind({ title: row.title, parentTitle: row.parent_title })) continue
      count += 1
      if (unclassified.length < 5) unclassified.push(row.id)
    }
  }
  if (count > 0) {
    throw new Error(`${DOC_KIND_BACKFILL_MIGRATION} postcondition failed: ${count} docs the classifier places still have a NULL kind (e.g. ${unclassified.join(", ")}); POST again to resume`)
  }
}
