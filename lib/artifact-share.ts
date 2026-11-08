/**
 * External (outsider) artifact share: a secret link plus ONE shared password.
 *
 * Trust model, in one place:
 *  - The link token is 32 random bytes. Only its sha256 is stored, so a database read cannot
 *    reconstruct a working link. The owner sees the raw token exactly once (enable / rotate).
 *  - The password is stored as an scrypt hash. Wrong guesses are counted BEFORE the password
 *    is checked, as a compare-and-set, so parallel guesses cannot beat the limit.
 *  - A successful unlock mints an opaque session token (sha256 stored, like PortalSession).
 *    Changing the password, rotating the link, or revoking deletes every session, and a
 *    session older than `passwordChangedAt` is rejected even if a row somehow survives.
 *  - External commenting needs an email provider (AUTH_RESEND_KEY) and is refused server-side
 *    without one, no matter what the owner UI sent.
 *
 * Nothing here imports from lib/portal-auth.ts's cookie machinery: a share viewer is neither
 * a Compass member nor a portal account until they verify an email to comment.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import getPrisma from "@/lib/db"

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>

export const SHARE_PASSWORD_MIN_LENGTH = 10
export const SHARE_PASSWORD_MAX_LENGTH = 200
/** Wrong-password budget per share per window. Counted before the password is checked. */
export const SHARE_MAX_FAILED_ATTEMPTS = 5
export const SHARE_FAILED_WINDOW_MS = 15 * 60 * 1000
export const SHARE_SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const SHARE_COMMENTER_TTL_MS = 12 * 60 * 60 * 1000

const SCRYPT = { N: 16384, r: 8, p: 1 } as const
const KEY_LENGTH = 32

export type ShareEventType =
  | "ENABLED"
  | "PASSWORD_CHANGED"
  | "LINK_ROTATED"
  | "COMMENTS_ENABLED"
  | "COMMENTS_DISABLED"
  | "REVOKED"

export class ArtifactShareError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message)
    this.name = "ArtifactShareError"
  }
}

/** External commenting sends a sign-in email, so it only exists where an email provider does. */
export function externalCommentingAvailable(): boolean {
  return Boolean(process.env.AUTH_RESEND_KEY)
}

export function hashShareToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex")
}

export function generateShareToken(): { rawToken: string; tokenHash: string } {
  const rawToken = randomBytes(32).toString("base64url")
  return { rawToken, tokenHash: hashShareToken(rawToken) }
}

/** A readable generated password for owners who don't want to invent one (~96 bits). */
export function generateSharePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
  const bytes = randomBytes(16)
  let out = ""
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[bytes[i] % alphabet.length]
    if (i % 4 === 3 && i !== 15) out += "-"
  }
  return out
}

export function assertValidSharePassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length < SHARE_PASSWORD_MIN_LENGTH) {
    throw new ArtifactShareError(400, `Password must be at least ${SHARE_PASSWORD_MIN_LENGTH} characters.`)
  }
  if (password.length > SHARE_PASSWORD_MAX_LENGTH) {
    throw new ArtifactShareError(400, `Password must be at most ${SHARE_PASSWORD_MAX_LENGTH} characters.`)
  }
}

export async function hashSharePassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT)
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), derived.toString("base64url")].join("$")
}

export async function verifySharePassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$")
  if (scheme !== "scrypt" || !salt || !hash) return false
  const params = { N: Number(n), r: Number(r), p: Number(p) }
  // Only ever verify with the parameters we write; a tampered row must not pick its own cost.
  if (params.N !== SCRYPT.N || params.r !== SCRYPT.r || params.p !== SCRYPT.p) return false
  const expected = Buffer.from(hash, "base64url")
  const actual = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, params)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

// A real hash to verify against when no share matches, so "unknown link" and "wrong password"
// cost the same and answer the same.
let decoyHash: Promise<string> | null = null
function getDecoyHash() {
  decoyHash ??= hashSharePassword(randomBytes(16).toString("base64url"))
  return decoyHash
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

async function retryDsql<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (errorCode(error) !== "P2034" || attempt === attempts - 1) throw error
    }
  }
  throw lastError
}

// ---------------------------------------------------------------------------
// Owner-side operations (callers have already proven workspace membership)
// ---------------------------------------------------------------------------

type OwnerInput = { workspaceId: string; artifactId: string; actorId: string }

async function requireShareableArtifact({ workspaceId, artifactId }: OwnerInput) {
  const artifact = await getPrisma().artifact.findFirst({
    where: { id: artifactId, workspaceId },
    select: { id: true, sourceType: true, status: true },
  })
  if (!artifact) throw new ArtifactShareError(404, "Artifact not found.")
  if (artifact.sourceType !== "HTML_UPLOAD") {
    throw new ArtifactShareError(400, "Only uploaded HTML artifacts can be shared externally.")
  }
  if (artifact.status === "ARCHIVED") throw new ArtifactShareError(400, "Archived artifacts cannot be shared.")
  return artifact
}

async function recordEvent(share: { id: string; artifactId: string; workspaceId: string }, eventType: ShareEventType, actorId: string) {
  await getPrisma().artifactShareEvent.create({
    data: { shareId: share.id, artifactId: share.artifactId, workspaceId: share.workspaceId, eventType, actorId },
  })
}

async function endAllSessions(shareId: string) {
  const prisma = getPrisma()
  await prisma.artifactShareSession.deleteMany({ where: { shareId } })
  await prisma.artifactShareCommenter.deleteMany({ where: { shareId } })
}

async function requireActiveShare(input: OwnerInput) {
  await requireShareableArtifact(input)
  const share = await getPrisma().artifactShare.findUnique({ where: { artifactId: input.artifactId } })
  if (!share || share.workspaceId !== input.workspaceId || share.revokedAt) {
    throw new ArtifactShareError(404, "This artifact is not shared.")
  }
  return share
}

export type OwnerShareState = {
  enabled: boolean
  commentsEnabled: boolean
  /** Server capability, so the UI can grey the toggle out instead of guessing. */
  commentingAvailable: boolean
  enabledAt: string | null
  passwordChangedAt: string | null
  events: { id: string; eventType: string; actorId: string; createdAt: string }[]
}

/** Never includes the token or any hash: the owner can rotate, not re-read. */
export async function getOwnerShareState(input: Pick<OwnerInput, "workspaceId" | "artifactId">): Promise<OwnerShareState> {
  const prisma = getPrisma()
  const share = await prisma.artifactShare.findUnique({ where: { artifactId: input.artifactId } })
  const owned = share && share.workspaceId === input.workspaceId ? share : null
  const events = owned
    ? await prisma.artifactShareEvent.findMany({
        where: { artifactId: input.artifactId, workspaceId: input.workspaceId },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { id: true, eventType: true, actorId: true, createdAt: true },
      })
    : []
  const enabled = Boolean(owned && !owned.revokedAt)
  return {
    enabled,
    commentsEnabled: enabled && Boolean(owned?.commentsEnabled) && externalCommentingAvailable(),
    commentingAvailable: externalCommentingAvailable(),
    enabledAt: enabled ? owned!.enabledAt.toISOString() : null,
    passwordChangedAt: enabled ? owned!.passwordChangedAt.toISOString() : null,
    events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
  }
}

/** Creates (or re-enables) the share. Returns the raw link token, shown once. */
export async function enableArtifactShare(input: OwnerInput & { password: string }): Promise<{ rawToken: string }> {
  assertValidSharePassword(input.password)
  await requireShareableArtifact(input)
  const prisma = getPrisma()
  const existing = await prisma.artifactShare.findUnique({ where: { artifactId: input.artifactId } })
  if (existing && existing.workspaceId !== input.workspaceId) throw new ArtifactShareError(404, "Artifact not found.")
  if (existing && !existing.revokedAt) throw new ArtifactShareError(409, "This artifact is already shared.")

  const { rawToken, tokenHash } = generateShareToken()
  const passwordHash = await hashSharePassword(input.password)
  const now = new Date()
  let share: { id: string; artifactId: string; workspaceId: string }
  if (existing) {
    // Re-enable after a revoke: a fresh token and password; comments back to off.
    share = await prisma.artifactShare.update({
      where: { id: existing.id },
      data: {
        tokenHash, passwordHash, passwordChangedAt: now, enabledAt: now, revokedAt: null, commentsEnabled: false,
        failedAttempts: 0, failedWindowAt: null, createdById: input.actorId, updatedAt: now,
      },
    })
    await endAllSessions(existing.id)
  } else {
    try {
      share = await prisma.artifactShare.create({
        data: {
          artifactId: input.artifactId, workspaceId: input.workspaceId, tokenHash, passwordHash,
          passwordChangedAt: now, enabledAt: now, createdById: input.actorId, createdAt: now, updatedAt: now,
        },
      })
    } catch (error) {
      if (errorCode(error) === "P2002") throw new ArtifactShareError(409, "This artifact is already shared.")
      throw error
    }
  }
  await recordEvent(share, "ENABLED", input.actorId)
  return { rawToken }
}

/** Replaces the password and signs every current viewer out. */
export async function changeArtifactSharePassword(input: OwnerInput & { password: string }): Promise<void> {
  assertValidSharePassword(input.password)
  const share = await requireActiveShare(input)
  const now = new Date()
  await getPrisma().artifactShare.update({
    where: { id: share.id },
    data: { passwordHash: await hashSharePassword(input.password), passwordChangedAt: now, failedAttempts: 0, failedWindowAt: null, updatedAt: now },
  })
  await endAllSessions(share.id)
  await recordEvent(share, "PASSWORD_CHANGED", input.actorId)
}

/** Invalidates the old link and signs every viewer out. Returns the new raw token, shown once. */
export async function rotateArtifactShareLink(input: OwnerInput): Promise<{ rawToken: string }> {
  const share = await requireActiveShare(input)
  const { rawToken, tokenHash } = generateShareToken()
  await getPrisma().artifactShare.update({ where: { id: share.id }, data: { tokenHash, updatedAt: new Date() } })
  await endAllSessions(share.id)
  await recordEvent(share, "LINK_ROTATED", input.actorId)
  return { rawToken }
}

export async function setArtifactShareComments(input: OwnerInput & { enabled: boolean }): Promise<void> {
  const share = await requireActiveShare(input)
  if (input.enabled && !externalCommentingAvailable()) {
    throw new ArtifactShareError(400, "External commenting needs an email provider, which isn't configured here.")
  }
  if (share.commentsEnabled === input.enabled) return
  await getPrisma().artifactShare.update({ where: { id: share.id }, data: { commentsEnabled: input.enabled, updatedAt: new Date() } })
  if (!input.enabled) await getPrisma().artifactShareCommenter.deleteMany({ where: { shareId: share.id } })
  await recordEvent(share, input.enabled ? "COMMENTS_ENABLED" : "COMMENTS_DISABLED", input.actorId)
}

export async function revokeArtifactShare(input: OwnerInput): Promise<void> {
  const share = await requireActiveShare(input)
  const now = new Date()
  await getPrisma().artifactShare.update({ where: { id: share.id }, data: { revokedAt: now, commentsEnabled: false, updatedAt: now } })
  await endAllSessions(share.id)
  await recordEvent(share, "REVOKED", input.actorId)
}

// ---------------------------------------------------------------------------
// Public-side operations (no Compass session; the link + password are the credential)
// ---------------------------------------------------------------------------

export type PublicShare = {
  id: string
  artifactId: string
  workspaceId: string
  passwordChangedAt: Date
  commentsEnabled: boolean
}

/** Resolves a raw link token to a live share, or null. Revoked or archived shares are null. */
export async function resolveShareByToken(rawToken: string): Promise<PublicShare | null> {
  if (typeof rawToken !== "string" || rawToken.length < 20 || rawToken.length > 100) return null
  const share = await getPrisma().artifactShare.findUnique({ where: { tokenHash: hashShareToken(rawToken) } })
  if (!share || share.revokedAt) return null
  const artifact = await getPrisma().artifact.findFirst({
    where: { id: share.artifactId, workspaceId: share.workspaceId, sourceType: "HTML_UPLOAD", status: { not: "ARCHIVED" } },
    select: { id: true },
  })
  if (!artifact) return null
  return {
    id: share.id,
    artifactId: share.artifactId,
    workspaceId: share.workspaceId,
    passwordChangedAt: share.passwordChangedAt,
    // Commenting is the AND of the owner's choice and the server's capability.
    commentsEnabled: share.commentsEnabled && externalCommentingAvailable(),
  }
}

/**
 * Spends one unlock attempt as a compare-and-set. Returns false when the budget for the
 * current window is already spent. Spending happens before the password is checked.
 */
async function spendUnlockAttempt(shareId: string): Promise<boolean> {
  return retryDsql(async () => {
    for (let tries = 0; tries < 5; tries += 1) {
      const prisma = getPrisma()
      const row = await prisma.artifactShare.findUnique({ where: { id: shareId }, select: { failedAttempts: true, failedWindowAt: true } })
      if (!row) return false
      const now = new Date()
      const active = Boolean(row.failedWindowAt && now.getTime() - row.failedWindowAt.getTime() < SHARE_FAILED_WINDOW_MS)
      const count = active ? row.failedAttempts : 0
      if (count >= SHARE_MAX_FAILED_ATTEMPTS) return false
      const updated = await prisma.artifactShare.updateMany({
        where: { id: shareId, failedAttempts: row.failedAttempts, failedWindowAt: row.failedWindowAt },
        data: active ? { failedAttempts: count + 1 } : { failedAttempts: 1, failedWindowAt: now },
      })
      if (updated.count === 1) return true
    }
    // Sustained contention: fail closed.
    return false
  })
}

export type UnlockResult =
  | { ok: true; sessionToken: string; expiresAt: Date }
  | { ok: false; reason: "invalid" | "locked" }

export async function unlockShare(rawToken: string, password: string): Promise<UnlockResult> {
  const share = await resolveShareByToken(rawToken)
  const candidate = typeof password === "string" && password.length <= SHARE_PASSWORD_MAX_LENGTH ? password : ""
  if (!share) {
    await verifySharePassword(candidate, await getDecoyHash())
    return { ok: false, reason: "invalid" }
  }
  if (!(await spendUnlockAttempt(share.id))) return { ok: false, reason: "locked" }
  const row = await getPrisma().artifactShare.findUnique({ where: { id: share.id }, select: { passwordHash: true } })
  const matches = row ? await verifySharePassword(candidate, row.passwordHash) : false
  if (!matches) return { ok: false, reason: "invalid" }

  const prisma = getPrisma()
  await prisma.artifactShare.update({ where: { id: share.id }, data: { failedAttempts: 0, failedWindowAt: null } })
  await prisma.artifactShareSession.deleteMany({ where: { shareId: share.id, expiresAt: { lt: new Date() } } })
  const sessionToken = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + SHARE_SESSION_TTL_MS)
  await prisma.artifactShareSession.create({
    data: { shareId: share.id, artifactId: share.artifactId, tokenHash: hashShareToken(sessionToken), expiresAt },
  })
  return { ok: true, sessionToken, expiresAt }
}

/** True only for an unexpired session of THIS share, minted after the current password was set. */
export async function verifyShareSession(share: PublicShare, rawSessionToken: string | undefined): Promise<boolean> {
  if (!rawSessionToken) return false
  const session = await getPrisma().artifactShareSession.findUnique({ where: { tokenHash: hashShareToken(rawSessionToken) } })
  return Boolean(
    session &&
      session.shareId === share.id &&
      session.artifactId === share.artifactId &&
      session.expiresAt.getTime() > Date.now() &&
      session.createdAt.getTime() >= share.passwordChangedAt.getTime(),
  )
}

/** Cookie name is per-share so two shares open in one browser don't evict each other. */
export function shareSessionCookieName(rawToken: string): string {
  return `cs_${hashShareToken(rawToken).slice(0, 16)}`
}
