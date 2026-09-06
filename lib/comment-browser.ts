import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { COMMENT_TARGET_TYPES, resolveCommentTarget, type CommentTargetType } from "@/lib/comments"
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"

export class CommentHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = "CommentHttpError"
  }
}

export type CommentActor = { userId: string; name: string; workspaceId: string; admin: boolean }
export type BrowserDocAnchor = { commentId: string; anchorText: string; anchorPrefix: string | null; anchorSuffix: string | null; anchorStart: number | null; anchorEnd: number | null }
export type BrowserSolutionPlanProposal = { commentId: string; trackedDecisionRequestId: string | null; legacyPlanStatus: string | null }
export type BrowserCommentRow = {
  id: string; workspaceId: string; targetType: string; targetId: string; parentId: string | null
  body: string; status: string; authorId: string | null; authorName: string; authorType: string; source: string
  createdAt: Date; updatedAt: Date; docAnchor: BrowserDocAnchor | null; solutionPlanProposal: BrowserSolutionPlanProposal | null
}
export type BrowserCommentDto = Omit<BrowserCommentRow, "createdAt" | "updatedAt"> & {
  createdAt: string; updatedAt: string; edited: boolean; canEdit: boolean; canDelete: boolean; canModerate: boolean; replies: BrowserCommentDto[]
}
type SessionUser = { id: string; name?: string | null }

function isCommentTargetType(value: string): value is CommentTargetType {
  return COMMENT_TARGET_TYPES.some((targetType) => targetType === value)
}

async function requireSessionUser(): Promise<SessionUser> {
  const session = await auth()
  if (!session?.user?.id) throw new CommentHttpError(401, "Unauthorized")
  return { id: session.user.id, name: session.user.name }
}

async function authorizeTargetForUser(targetType: CommentTargetType, targetId: string, user: SessionUser): Promise<CommentActor> {
  const target = await resolveCommentTarget(targetType, targetId)
  if (!target) throw new CommentHttpError(404, "Not found")
  const workspace = await getPrisma().workspace.findUnique({
    where: { id: target.workspaceId },
    select: {
      members: { where: { userId: user.id }, select: { role: true } },
      organization: { select: { members: { where: { userId: user.id }, select: { role: true } } } },
    },
  })
  const workspaceRole = workspace?.members[0]?.role
  const orgRole = workspace?.organization?.members[0]?.role
  const orgAdmin = isOrgAdminRole(orgRole)
  if (!workspaceRole && !orgAdmin) throw new CommentHttpError(404, "Not found")
  return {
    userId: user.id,
    name: user.name?.trim() || "Compass user",
    workspaceId: target.workspaceId,
    admin: normalizeWorkspaceRole(workspaceRole) === "ADMIN" || orgAdmin,
  }
}

export async function authorizeCommentTarget(targetType: CommentTargetType, targetId: string): Promise<CommentActor> {
  return authorizeTargetForUser(targetType, targetId, await requireSessionUser())
}

export async function authorizeComment(commentId: string) {
  const user = await requireSessionUser()
  const stored = await getPrisma().comment.findUnique({
    where: { id: commentId },
    select: { id: true, authorId: true, targetType: true, targetId: true, workspaceId: true, parentId: true, solutionPlanProposal: { select: { commentId: true } }, _count: { select: { replies: true } } },
  })
  if (!stored || !isCommentTargetType(stored.targetType)) throw new CommentHttpError(404, "Not found")
  const actor = await authorizeTargetForUser(stored.targetType, stored.targetId, user)
  if (actor.workspaceId !== stored.workspaceId) throw new CommentHttpError(404, "Not found")
  const { _count, ...comment } = stored
  return { ...actor, comment: { ...comment, replyCount: _count.replies, hasPlanProposal: Boolean(comment.solutionPlanProposal) }, owns: comment.authorId !== null && comment.authorId === actor.userId }
}

export async function listBrowserComments(workspaceId: string, targetType: CommentTargetType, targetId: string) {
  return getPrisma().comment.findMany({
    where: { workspaceId, targetType, targetId, ...(targetType === "SOLUTION" ? { solutionPlanProposal: { is: null } } : {}) },
    include: { docAnchor: true, solutionPlanProposal: true },
    orderBy: { createdAt: "asc" },
  }) as Promise<BrowserCommentRow[]>
}

export async function deleteBrowserComment(commentId: string, actor: Pick<CommentActor, "admin" | "userId">, deleteThread: boolean) {
  const prisma = getPrisma()
  const operation = () => prisma.$transaction(async (tx) => {
    const current = await tx.comment.findUnique({
      where: { id: commentId },
      select: { id: true, parentId: true, authorId: true, solutionPlanProposal: { select: { commentId: true } }, _count: { select: { replies: true } } },
    })
    if (!current || current.solutionPlanProposal) throw new CommentHttpError(404, "Not found")
    const owns = current.authorId !== null && current.authorId === actor.userId
    if (!owns && !actor.admin) throw new CommentHttpError(404, "Not found")
    if (!current.parentId && current._count.replies > 0 && !(actor.admin && deleteThread)) {
      throw new CommentHttpError(409, "Admin confirmation is required to delete a thread with replies.")
    }
    const replies = current.parentId ? [] : await tx.comment.findMany({ where: { parentId: commentId }, select: { id: true } })
    const ids = [...replies.map(({ id }) => id), commentId]
    await tx.docCommentAnchor.deleteMany({ where: { commentId: { in: ids } } })
    if (replies.length) await tx.comment.deleteMany({ where: { parentId: commentId } })
    await tx.comment.delete({ where: { id: commentId } })
    return { id: commentId, deletedReplies: replies.length }
  // Aurora DSQL supports Repeatable Read, not Serializable. Keep the checks and
  // dependent deletes in one transaction so failures roll back the whole delete.
  }, { isolationLevel: "RepeatableRead" })
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation() } catch (error) {
      lastError = error
      const value = error as { code?: string; meta?: { code?: string }; message?: string }
      const retryable = value.code === "P2034" || value.code === "40001" || value.meta?.code === "40001" || /OC00\d|serialization/i.test(value.message ?? "")
      if (!retryable || attempt === 2) throw error
    }
  }
  throw lastError
}

function baseDto(row: BrowserCommentRow, actor: CommentActor): BrowserCommentDto {
  const owns = row.authorId !== null && row.authorId === actor.userId
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), edited: row.updatedAt.getTime() !== row.createdAt.getTime(), canEdit: actor.admin || owns, canDelete: actor.admin || owns, canModerate: true, replies: [] }
}

export function toCommentThreads(rows: BrowserCommentRow[], actor: CommentActor): BrowserCommentDto[] {
  const roots = rows.filter((row) => row.parentId === null).map((row) => baseDto(row, actor))
  const rootsById = new Map(roots.map((root) => [root.id, root]))
  for (const row of rows) if (row.parentId) rootsById.get(row.parentId)?.replies.push(baseDto(row, actor))
  for (const root of roots) if (root.replies.length > 0 && !actor.admin) root.canDelete = false
  return roots
}

export function toCommentDto(row: BrowserCommentRow, actor: CommentActor): BrowserCommentDto {
  return baseDto(row, actor)
}
