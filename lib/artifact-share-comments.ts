/**
 * Outsider commenting on an externally shared artifact.
 *
 * Gates, all enforced here and in the routes that call this (never only in the UI):
 *  1. the viewer holds a valid unlock session (link + password),
 *  2. the share has commenting on AND the server has an email provider (PublicShare.commentsEnabled),
 *  3. the viewer proved an email address via a one-time link, which yields an
 *     ArtifactShareCommenter session bound to THIS share.
 *
 * Visibility is by AUTHORSHIP, not by thread: an outsider is shown exactly the comments whose
 * CommentExternalAuthor.portalAccountId is their own. Internal comments, internal replies, pins,
 * and other outsiders' comments therefore cannot match, whatever the artifact's thread looks like.
 * Replies are only accepted against the viewer's own root comment.
 */
import { createHash, randomBytes } from "node:crypto"
import getPrisma from "@/lib/db"
import { createComment } from "@/lib/comments"
import { SHARE_COMMENTER_TTL_MS, hashShareToken, type PublicShare } from "@/lib/artifact-share"
import { normalizePortalEmail } from "@/lib/portal-auth"

export const SHARE_MAGIC_LINK_TTL_MS = 15 * 60 * 1000
export const SHARE_COMMENT_MAX_LENGTH = 4000
/** Per commenter per artifact per hour. */
export const SHARE_COMMENT_HOURLY_LIMIT = 30
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class ShareCommentError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 429, message: string) {
    super(message)
    this.name = "ShareCommentError"
  }
}

export type VisibleShareComment = { id: string; parentId: string | null; body: string; createdAt: string }
export type ShareCommenter = { commenterId: string; portalAccountId: string; email: string }

/**
 * Magic-link tokens live in PortalVerificationToken but are hashed with a share-bound prefix, so
 * the portal verify route (which hashes the bare token) can never redeem one, and a link minted
 * for one share can never be redeemed against another.
 */
export function hashMagicToken(shareId: string, rawToken: string): string {
  return createHash("sha256").update(`artifact-share:${shareId}:${rawToken}`).digest("hex")
}

export function commenterCookieName(rawShareToken: string): string {
  return `cc_${hashShareToken(rawShareToken).slice(0, 16)}`
}

export function assertCommentingOpen(share: PublicShare) {
  if (!share.commentsEnabled) throw new ShareCommentError(403, "Commenting isn't available on this link.")
}

export function parseEmail(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !EMAIL_RE.test(value.trim())) {
    throw new ShareCommentError(400, "Enter a valid email address.")
  }
  return normalizePortalEmail(value)
}

/**
 * Creates the one-time sign-in token for an email. Returns null (and creates nothing) while a
 * live token for this email+share exists, so the caller can answer identically either way:
 * no enumeration oracle and no inbox-bombing a third party.
 */
export async function issueMagicToken(share: PublicShare, email: string): Promise<{ rawToken: string } | null> {
  const prisma = getPrisma()
  const live = await prisma.portalVerificationToken.findMany({ where: { email, expiresAt: { gt: new Date() } }, select: { tokenHash: true } })
  // We cannot tell which live token is ours without the raw value, so any live token for this
  // email (portal or share) throttles. Conservative on purpose.
  if (live.length > 0) return null
  const rawToken = randomBytes(32).toString("base64url")
  await prisma.portalVerificationToken.create({
    data: { email, tokenHash: hashMagicToken(share.id, rawToken), expiresAt: new Date(Date.now() + SHARE_MAGIC_LINK_TTL_MS) },
  })
  return { rawToken }
}

/** Consumes a magic token and mints a commenter session. Single use. */
export async function redeemMagicToken(share: PublicShare, rawToken: string): Promise<{ commenterToken: string; expiresAt: Date } | null> {
  if (typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 100) return null
  const prisma = getPrisma()
  const tokenHash = hashMagicToken(share.id, rawToken)
  const row = await prisma.portalVerificationToken.findUnique({ where: { tokenHash } })
  if (!row || row.expiresAt.getTime() <= Date.now()) return null
  // Single use: only the caller whose delete actually removed the row proceeds.
  const deleted = await prisma.portalVerificationToken.deleteMany({ where: { id: row.id } })
  if (deleted.count !== 1) return null

  const account = await prisma.portalAccount.upsert({
    where: { email: row.email },
    update: {},
    create: { email: row.email, emailVerified: new Date() },
  })
  const commenterToken = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + SHARE_COMMENTER_TTL_MS)
  await prisma.artifactShareCommenter.deleteMany({ where: { shareId: share.id, expiresAt: { lt: new Date() } } })
  await prisma.artifactShareCommenter.create({
    data: { shareId: share.id, artifactId: share.artifactId, portalAccountId: account.id, tokenHash: hashShareToken(commenterToken), expiresAt },
  })
  return { commenterToken, expiresAt }
}

export async function verifyCommenter(share: PublicShare, rawCommenterToken: string | undefined): Promise<ShareCommenter | null> {
  if (!rawCommenterToken) return null
  const prisma = getPrisma()
  const row = await prisma.artifactShareCommenter.findUnique({ where: { tokenHash: hashShareToken(rawCommenterToken) } })
  if (
    !row ||
    row.shareId !== share.id ||
    row.artifactId !== share.artifactId ||
    row.expiresAt.getTime() <= Date.now() ||
    row.createdAt.getTime() < share.passwordChangedAt.getTime()
  ) {
    return null
  }
  const account = await prisma.portalAccount.findUnique({ where: { id: row.portalAccountId }, select: { id: true, email: true } })
  return account ? { commenterId: row.id, portalAccountId: account.id, email: account.email } : null
}

/** Only this commenter's own comments, nothing else — see the module comment. */
export async function listOwnShareComments(share: PublicShare, commenter: ShareCommenter): Promise<VisibleShareComment[]> {
  const rows = await getPrisma().comment.findMany({
    where: {
      workspaceId: share.workspaceId,
      targetType: "ARTIFACT",
      targetId: share.artifactId,
      source: "SHARE",
      externalAuthor: { portalAccountId: commenter.portalAccountId },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, parentId: true, body: true, createdAt: true },
  })
  return rows.map((row) => ({ id: row.id, parentId: row.parentId, body: row.body, createdAt: row.createdAt.toISOString() }))
}

export async function createShareComment(
  share: PublicShare,
  commenter: ShareCommenter,
  input: { body?: unknown; parentId?: unknown },
): Promise<VisibleShareComment> {
  const body = typeof input.body === "string" ? input.body.trim() : ""
  if (!body || body.length > SHARE_COMMENT_MAX_LENGTH) {
    throw new ShareCommentError(400, `Write a comment of up to ${SHARE_COMMENT_MAX_LENGTH} characters.`)
  }
  const prisma = getPrisma()
  const parentId = typeof input.parentId === "string" && input.parentId ? input.parentId : null
  if (parentId) {
    // A reply may only target the viewer's OWN root comment; anything else (including internal
    // comments, whose ids the viewer should never know) is reported as not found.
    const parent = await prisma.comment.findFirst({
      where: {
        id: parentId, workspaceId: share.workspaceId, targetType: "ARTIFACT", targetId: share.artifactId,
        source: "SHARE", parentId: null, externalAuthor: { portalAccountId: commenter.portalAccountId },
      },
      select: { id: true },
    })
    if (!parent) throw new ShareCommentError(404, "Comment not found.")
  }
  const recent = await prisma.comment.count({
    where: {
      workspaceId: share.workspaceId, targetType: "ARTIFACT", targetId: share.artifactId, source: "SHARE",
      externalAuthor: { portalAccountId: commenter.portalAccountId }, createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
    },
  })
  if (recent >= SHARE_COMMENT_HOURLY_LIMIT) throw new ShareCommentError(429, "You're commenting too fast. Try again later.")

  const created = await createComment(
    {
      workspaceId: share.workspaceId,
      targetType: "ARTIFACT",
      targetId: share.artifactId,
      parentId,
      body,
      source: "SHARE",
      authorId: null,
      authorName: commenter.email,
      authorType: "HUMAN",
      externalAuthor: { submitterEmail: commenter.email, portalAccountId: commenter.portalAccountId },
    },
    {
      // Re-check inside the write: the share may have been revoked, commenting switched off, or
      // the commenter signed out between the request's checks and the insert.
      beforeCreate: async (tx) => {
        const [liveShare, liveCommenter] = await Promise.all([
          tx.artifactShare.findFirst({ where: { id: share.id, revokedAt: null, commentsEnabled: true }, select: { id: true } }),
          tx.artifactShareCommenter.findFirst({ where: { id: commenter.commenterId, shareId: share.id }, select: { id: true } }),
        ])
        if (!liveShare || !liveCommenter) throw new ShareCommentError(403, "Commenting isn't available on this link.")
      },
    },
  )
  if (!created) throw new ShareCommentError(400, "Comment could not be saved.")
  return { id: created.id, parentId: created.parentId, body: created.body, createdAt: created.createdAt.toISOString() }
}

/** Sends the sign-in email. Throws if the provider rejects it so the route can say so. */
export async function sendShareSignInEmail(email: string, verifyUrl: string): Promise<void> {
  const key = process.env.AUTH_RESEND_KEY
  if (!key) throw new ShareCommentError(403, "Commenting isn't available on this link.")
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM ?? "Compass <noreply@compass.app>",
      to: email,
      subject: "Confirm your email to comment",
      html: `<p>Confirm your email address to leave comments on the shared document:</p><p><a href="${verifyUrl}">Confirm email</a></p><p>This link expires in 15 minutes and works once.</p>`,
    }),
  })
  if (!response.ok) throw new Error(`Email provider rejected the message (${response.status})`)
}
