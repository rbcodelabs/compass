/**
 * Handler functions for the SolutionComment MCP tools (add_solution_plan,
 * add_solution_comment, list_solution_comments, get_solution_comment,
 * update_solution_comment, delete_solution_comment).
 *
 * Extracted into this module (rather than left inline in app/api/mcp/route.ts)
 * so every tool — including the "add" tools, which the codebase convention
 * otherwise leaves inline — can be unit-tested. This entity needs full
 * read/write symmetry tested end to end, per .claude/pr-guidelines.md.
 *
 * MCP tool handlers have no access to a resolved per-user identity —
 * validateMcpAuth is only checked once at the top of the route as a gate —
 * so authorName is always a required explicit input here, never derived.
 */

import getPrisma from "@/lib/db"
import { ok, fail } from "@/lib/mcp-output"
import { deleteMirroredComment, mirrorLegacySolutionComment, updateMirroredComment, updateMirroredLegacyPlanStatus } from "@/lib/comment-compat"

type CommentType = "PLAN" | "COMMENT"
type AuthorType = "AGENT" | "HUMAN"
type PlanStatus = "PENDING" | "APPROVED" | "REJECTED"

function truncate(s: string, max: number) {
  return s.length > max ? `${s.slice(0, max)}...` : s
}

// ── add_solution_plan ───────────────────────────────────────────────────────

export async function addSolutionPlan({
  solutionId,
  body,
  authorName,
}: {
  solutionId: string
  body: string
  authorName: string
}) {
  const prisma = getPrisma()

  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true },
  })
  if (!solution) {
    return fail(`Solution "${solutionId}" not found.`)
  }

  const comment = await prisma.solutionComment.create({
    data: {
      solutionId,
      commentType: "PLAN",
      body: body.trim(),
      authorName,
      authorType: "AGENT",
      source: "MCP",
    },
  })
  try { await mirrorLegacySolutionComment(comment) } catch (error) { await prisma.solutionComment.delete({ where: { id: comment.id } }); throw error }

  return ok(
    `**Plan added** to solution "${solution.title}"\n` +
      `Author: ${comment.authorName}\n` +
      `Body: ${truncate(comment.body, 120)}\n` +
      `ID: ${comment.id}`,
    comment
  )
}

// ── add_solution_comment ─────────────────────────────────────────────────────

export async function addSolutionComment({
  solutionId,
  body,
  authorName,
  authorType,
}: {
  solutionId: string
  body: string
  authorName: string
  authorType?: AuthorType
}) {
  const prisma = getPrisma()

  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true },
  })
  if (!solution) {
    return fail(`Solution "${solutionId}" not found.`)
  }

  const comment = await prisma.solutionComment.create({
    data: {
      solutionId,
      commentType: "COMMENT",
      body: body.trim(),
      authorName,
      authorType: authorType ?? "AGENT",
      source: "MCP",
    },
  })
  try { await mirrorLegacySolutionComment(comment) } catch (error) { await prisma.solutionComment.delete({ where: { id: comment.id } }); throw error }

  return ok(
    `**Comment added** to solution "${solution.title}"\n` +
      `Author: ${comment.authorName} (${comment.authorType})\n` +
      `Body: ${truncate(comment.body, 120)}\n` +
      `ID: ${comment.id}`,
    comment
  )
}

// ── list_solution_comments ───────────────────────────────────────────────────

export async function listSolutionComments({ solutionId }: { solutionId: string }) {
  const prisma = getPrisma()

  const solution = await prisma.solution.findUnique({
    where: { id: solutionId },
    select: { id: true, title: true },
  })
  if (!solution) {
    return fail(`Solution "${solutionId}" not found.`)
  }

  const comments = await prisma.solutionComment.findMany({
    where: { solutionId },
    orderBy: { createdAt: "asc" },
  })

  if (comments.length === 0) {
    return fail(`No comments yet on solution "${solution.title}".`)
  }

  const entries = comments.map(
    (c) =>
      `[${c.commentType}${c.commentType === "PLAN" ? ` — ${c.planStatus}` : ""}] ${c.authorName} (${c.authorType}) — ${c.createdAt.toISOString()}\n` +
      `${c.body}\n` +
      `ID: ${c.id}`
  )

  return ok(
    `Thread for solution "${solution.title}" (${comments.length} entries):\n\n${entries.join("\n\n")}`,
    {
      items: comments.map((c) => ({
        id: c.id,
        kind: c.commentType,
        body: c.body,
        authorName: c.authorName,
        status: c.planStatus,
      })),
      count: comments.length,
    }
  )
}

// ── get_solution_comment ─────────────────────────────────────────────────────

export async function getSolutionComment({ commentId }: { commentId: string }) {
  const prisma = getPrisma()

  const comment = await prisma.solutionComment.findUnique({ where: { id: commentId } })
  if (!comment) {
    return fail(`Comment "${commentId}" not found.`)
  }

  return ok(
    `[${comment.commentType}] ${comment.authorName} (${comment.authorType})\n` +
      (comment.commentType === "PLAN" ? `Status: ${comment.planStatus}\n` : "") +
      `${comment.body}\n` +
      `Created: ${comment.createdAt.toISOString()}\n` +
      `ID: ${comment.id}`,
    comment
  )
}

// ── update_solution_comment ──────────────────────────────────────────────────

export async function updateSolutionComment({
  commentId,
  body,
}: {
  commentId: string
  body: string
}) {
  const prisma = getPrisma()

  const existing = await prisma.solutionComment.findUnique({
    where: { id: commentId },
    select: { id: true, commentType: true },
  })
  if (!existing) {
    return fail(`Comment "${commentId}" not found.`)
  }

  // DSQL has no @updatedAt trigger support — set it explicitly.
  const updated = await prisma.solutionComment.update({
    where: { id: commentId },
    data: { body: body.trim(), updatedAt: new Date() },
  })
  await updateMirroredComment(commentId, updated.body)

  return ok(
    `**Comment updated**\n` +
      `Type: ${updated.commentType}\n` +
      `Body: ${truncate(updated.body, 120)}\n` +
      `ID: ${updated.id}`,
    updated
  )
}

// ── delete_solution_comment ──────────────────────────────────────────────────

export async function deleteSolutionComment({ commentId }: { commentId: string }) {
  const prisma = getPrisma()

  const existing = await prisma.solutionComment.findUnique({
    where: { id: commentId },
    select: { id: true, commentType: true, body: true },
  })
  if (!existing) {
    return fail(`Comment "${commentId}" not found.`)
  }

  // SolutionComment has no dependent rows (no experiments/evidence attach to
  // it), so — unlike deleteAssumption — there's nothing to null out first.
  await prisma.solutionComment.delete({ where: { id: commentId } })
  await deleteMirroredComment(commentId)

  return ok(
    `**Comment deleted**\n` +
      `Type: ${existing.commentType}\n` +
      `ID: ${existing.id}`,
    { id: existing.id, deleted: true }
  )
}

// ── approve_solution_plan / reject_solution_plan ───────────────────────────
// Approving/rejecting only applies to PLAN entries — a COMMENT has nothing
// to approve. Purely a status marker: no side effects on Solution.status.

async function setSolutionPlanStatus(commentId: string, planStatus: PlanStatus) {
  const prisma = getPrisma()

  const existing = await prisma.solutionComment.findUnique({
    where: { id: commentId },
    select: { id: true, commentType: true, body: true },
  })
  if (!existing) {
    return fail(`Comment "${commentId}" not found.`)
  }
  if (existing.commentType !== "PLAN") {
    return fail(
      `Comment "${commentId}" is a COMMENT, not a PLAN. Only PLAN entries can be approved or rejected.`
    )
  }

  const updated = await prisma.solutionComment.update({
    where: { id: commentId },
    data: { planStatus, updatedAt: new Date() },
  })
  await updateMirroredLegacyPlanStatus(commentId, planStatus)

  return ok(
    `**Plan ${planStatus === "APPROVED" ? "approved" : "rejected"}**\n` +
      `Body: ${truncate(updated.body, 120)}\n` +
      `ID: ${updated.id}`,
    updated
  )
}

export async function approveSolutionPlan({ commentId }: { commentId: string }) {
  return setSolutionPlanStatus(commentId, "APPROVED")
}

export async function rejectSolutionPlan({ commentId }: { commentId: string }) {
  return setSolutionPlanStatus(commentId, "REJECTED")
}

export type { CommentType, AuthorType, PlanStatus }
