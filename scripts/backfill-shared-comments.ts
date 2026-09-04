#!/usr/bin/env node
import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"
import { getActiveSchema } from "../lib/schema.ts"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; run this against local/preview through an authenticated environment.")
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: process.env.COMMENT_BACKFILL_SCHEMA ?? getActiveSchema() }) })
const BATCH_SIZE = 500

async function backfillDocs() {
  let cursor: string | undefined
  for (;;) {
    const rows = await prisma.docComment.findMany({
      take: BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" },
      include: { doc: { select: { workspaceId: true } } },
    })
    if (!rows.length) break
    const orphan = rows.find((row) => !row.doc)
    if (orphan) throw new Error(`Legacy DocComment ${orphan.id} references missing Doc ${orphan.docId}; refusing to fabricate workspace ownership.`)
    await prisma.comment.createMany({ skipDuplicates: true, data: rows.map((row) => ({ id: row.id, workspaceId: row.doc.workspaceId, targetType: "DOC", targetId: row.docId, parentId: row.parentId, body: row.body, status: row.status, authorId: row.authorId, authorName: row.authorName, authorType: row.authorType, source: row.source, createdAt: row.createdAt, updatedAt: row.updatedAt })) })
    const anchors = rows.filter((row) => !row.parentId && row.anchorText).map((row) => ({ commentId: row.id, anchorText: row.anchorText!, anchorPrefix: row.anchorPrefix, anchorSuffix: row.anchorSuffix, anchorStart: row.anchorStart, anchorEnd: row.anchorEnd }))
    if (anchors.length) await prisma.docCommentAnchor.createMany({ skipDuplicates: true, data: anchors })
    cursor = rows.at(-1)!.id
  }
}

async function backfillSolutions() {
  let cursor: string | undefined
  for (;;) {
    const rows = await prisma.solutionComment.findMany({
      take: BATCH_SIZE, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" },
      include: { solution: { select: { opportunity: { select: { workspaceId: true } } } } },
    })
    if (!rows.length) break
    const orphan = rows.find((row) => !row.solution?.opportunity)
    if (orphan) throw new Error(`Legacy SolutionComment ${orphan.id} has no workspace-owning Solution/Opportunity; refusing to fabricate ownership.`)
    await prisma.comment.createMany({ skipDuplicates: true, data: rows.map((row) => ({ id: row.id, workspaceId: row.solution.opportunity.workspaceId, targetType: "SOLUTION", targetId: row.solutionId, parentId: null, body: row.body, status: "OPEN", authorId: null, authorName: row.authorName, authorType: row.authorType, source: row.source, createdAt: row.createdAt, updatedAt: row.updatedAt })) })
    const plans = rows.filter((row) => row.commentType === "PLAN").map((row) => ({ commentId: row.id, trackedDecisionRequestId: null, legacyPlanStatus: row.planStatus }))
    if (plans.length) await prisma.solutionPlanProposal.createMany({ skipDuplicates: true, data: plans })
    cursor = rows.at(-1)!.id
  }
}

async function main() {
  await backfillDocs()
  await backfillSolutions()
  console.log("Shared comment backfill complete. Run scripts/validate-shared-comments-backfill.ts next.")
}

main().finally(async () => { await prisma.$disconnect(); await pool.end() })
