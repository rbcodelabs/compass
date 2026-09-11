import type { PoolClient } from "pg"
import { getActiveSchema } from "@/lib/schema"

export type SharedCommentsBackfillOperation = "backfill" | "validate"

type CountRow = Record<string, string | number | bigint>

function count(row: CountRow | undefined, key: string) {
  return Number(row?.[key] ?? 0)
}

function schemaIdentifier() {
  return `"${getActiveSchema().replaceAll('"', '""')}"`
}

async function invariants(client: PoolClient) {
  const schema = schemaIdentifier()
  const { rows } = await client.query<CountRow>(`
    SELECT
      (SELECT COUNT(*) FROM ${schema}.doc_comments dc LEFT JOIN ${schema}.docs d ON d.id=dc.doc_id WHERE d.id IS NULL)::bigint AS orphaned_doc_comments,
      (SELECT COUNT(*) FROM ${schema}.solution_comments sc LEFT JOIN ${schema}.solutions s ON s.id=sc.solution_id LEFT JOIN ${schema}.opportunities o ON o.id=s.opportunity_id WHERE o.id IS NULL)::bigint AS orphaned_solution_comments,
      (SELECT COUNT(*) FROM ${schema}.doc_comments dc LEFT JOIN ${schema}.comments c ON c.id=dc.id WHERE c.id IS NULL OR c.target_type<>'DOC' OR c.target_id<>dc.doc_id)::bigint AS missing_or_mismatched_doc_comments,
      (SELECT COUNT(*) FROM ${schema}.solution_comments sc LEFT JOIN ${schema}.comments c ON c.id=sc.id WHERE c.id IS NULL OR c.target_type<>'SOLUTION' OR c.target_id<>sc.solution_id)::bigint AS missing_or_mismatched_solution_comments,
      (SELECT COUNT(*) FROM ${schema}.doc_comments dc LEFT JOIN ${schema}.doc_comment_anchors a ON a.comment_id=dc.id WHERE dc.parent_id IS NULL AND dc.anchor_text IS NOT NULL AND a.comment_id IS NULL)::bigint AS missing_anchors,
      (SELECT COUNT(*) FROM ${schema}.solution_comments sc LEFT JOIN ${schema}.solution_plan_proposals p ON p.comment_id=sc.id WHERE sc.comment_type='PLAN' AND p.comment_id IS NULL)::bigint AS missing_plans,
      (SELECT COUNT(*) FROM ${schema}.comments r LEFT JOIN ${schema}.comments p ON p.id=r.parent_id WHERE r.parent_id IS NOT NULL AND (p.id IS NULL OR r.workspace_id<>p.workspace_id OR r.target_type<>p.target_type OR r.target_id<>p.target_id OR p.parent_id IS NOT NULL))::bigint AS invalid_replies
  `)
  const row = rows[0]
  const result = {
    orphanedDocComments: count(row, "orphaned_doc_comments"),
    orphanedSolutionComments: count(row, "orphaned_solution_comments"),
    missingOrMismatchedDocComments: count(row, "missing_or_mismatched_doc_comments"),
    missingOrMismatchedSolutionComments: count(row, "missing_or_mismatched_solution_comments"),
    missingAnchors: count(row, "missing_anchors"),
    missingPlans: count(row, "missing_plans"),
    invalidReplies: count(row, "invalid_replies"),
  }
  return { ...result, passed: Object.values(result).every((value) => value === 0) }
}

async function insertBatch(client: PoolClient, batchSize: number) {
  const schema = schemaIdentifier()
  const docs = await client.query(`
    INSERT INTO ${schema}.comments (id,workspace_id,target_type,target_id,parent_id,body,status,author_id,author_name,author_type,source,created_at,updated_at)
    SELECT dc.id,d.workspace_id,'DOC',dc.doc_id,dc.parent_id,dc.body,dc.status,dc.author_id,dc.author_name,dc.author_type,dc.source,dc.created_at,dc.updated_at
    FROM ${schema}.doc_comments dc JOIN ${schema}.docs d ON d.id=dc.doc_id
    LEFT JOIN ${schema}.comments c ON c.id=dc.id WHERE c.id IS NULL ORDER BY dc.id LIMIT $1
    ON CONFLICT (id) DO NOTHING`, [batchSize])
  const solutions = await client.query(`
    INSERT INTO ${schema}.comments (id,workspace_id,target_type,target_id,parent_id,body,status,author_id,author_name,author_type,source,created_at,updated_at)
    SELECT sc.id,o.workspace_id,'SOLUTION',sc.solution_id,NULL,sc.body,'OPEN',NULL,sc.author_name,sc.author_type,sc.source,sc.created_at,sc.updated_at
    FROM ${schema}.solution_comments sc JOIN ${schema}.solutions s ON s.id=sc.solution_id JOIN ${schema}.opportunities o ON o.id=s.opportunity_id
    LEFT JOIN ${schema}.comments c ON c.id=sc.id WHERE c.id IS NULL ORDER BY sc.id LIMIT $1
    ON CONFLICT (id) DO NOTHING`, [batchSize])
  const anchors = await client.query(`
    INSERT INTO ${schema}.doc_comment_anchors (comment_id,anchor_text,anchor_prefix,anchor_suffix,anchor_start,anchor_end)
    SELECT dc.id,dc.anchor_text,dc.anchor_prefix,dc.anchor_suffix,dc.anchor_start,dc.anchor_end
    FROM ${schema}.doc_comments dc JOIN ${schema}.comments c ON c.id=dc.id
    LEFT JOIN ${schema}.doc_comment_anchors a ON a.comment_id=dc.id
    WHERE c.target_type='DOC' AND c.target_id=dc.doc_id AND dc.parent_id IS NULL AND dc.anchor_text IS NOT NULL AND a.comment_id IS NULL ORDER BY dc.id LIMIT $1
    ON CONFLICT (comment_id) DO NOTHING`, [batchSize])
  const plans = await client.query(`
    INSERT INTO ${schema}.solution_plan_proposals (comment_id,tracked_decision_request_id,legacy_plan_status)
    SELECT sc.id,NULL,sc.plan_status FROM ${schema}.solution_comments sc JOIN ${schema}.comments c ON c.id=sc.id
    LEFT JOIN ${schema}.solution_plan_proposals p ON p.comment_id=sc.id
    WHERE c.target_type='SOLUTION' AND c.target_id=sc.solution_id AND sc.comment_type='PLAN' AND p.comment_id IS NULL ORDER BY sc.id LIMIT $1
    ON CONFLICT (comment_id) DO NOTHING`, [batchSize])
  return {
    insertedDocComments: docs.rowCount ?? 0,
    insertedSolutionComments: solutions.rowCount ?? 0,
    insertedAnchors: anchors.rowCount ?? 0,
    insertedPlans: plans.rowCount ?? 0,
  }
}

export async function runSharedCommentsBackfill(
  client: PoolClient,
  options: { operation: SharedCommentsBackfillOperation; batchSize: number },
) {
  const before = await invariants(client)
  if (before.orphanedDocComments || before.orphanedSolutionComments) {
    return { operation: options.operation, complete: false, invariants: before }
  }
  const processed = options.operation === "backfill" ? await insertBatch(client, options.batchSize) : undefined
  const after = options.operation === "backfill" ? await invariants(client) : before
  return { operation: options.operation, batchSize: options.batchSize, processed, complete: after.passed, invariants: after }
}
