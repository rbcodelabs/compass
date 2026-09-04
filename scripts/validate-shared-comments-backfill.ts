#!/usr/bin/env node
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { getActiveSchema } from "../lib/schema.ts"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.")
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: process.env.COMMENT_BACKFILL_SCHEMA ?? getActiveSchema() }) })

async function main() {
  const [legacyDocs, sharedDocs, legacySolutions, sharedSolutions, missingAnchors, missingPlans, invalidReplies] = await Promise.all([
    prisma.docComment.count(), prisma.comment.count({ where: { targetType: "DOC" } }),
    prisma.solutionComment.count(), prisma.comment.count({ where: { targetType: "SOLUTION" } }),
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM doc_comments dc LEFT JOIN doc_comment_anchors a ON a.comment_id = dc.id WHERE dc.parent_id IS NULL AND dc.anchor_text IS NOT NULL AND a.comment_id IS NULL`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM solution_comments sc LEFT JOIN solution_plan_proposals p ON p.comment_id = sc.id WHERE sc.comment_type = 'PLAN' AND p.comment_id IS NULL`,
    prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*) AS count FROM comments r JOIN comments p ON p.id = r.parent_id WHERE r.workspace_id <> p.workspace_id OR r.target_type <> p.target_type OR r.target_id <> p.target_id OR p.parent_id IS NOT NULL`,
  ])
  const result = { legacyDocs, sharedDocs, legacySolutions, sharedSolutions, missingAnchors: Number(missingAnchors[0]?.count ?? 0), missingPlans: Number(missingPlans[0]?.count ?? 0), invalidReplies: Number(invalidReplies[0]?.count ?? 0) }
  console.log(JSON.stringify(result, null, 2))
  if (legacyDocs !== sharedDocs || legacySolutions !== sharedSolutions || result.missingAnchors || result.missingPlans || result.invalidReplies) process.exitCode = 1
}

main().finally(async () => { await prisma.$disconnect(); await pool.end() })
