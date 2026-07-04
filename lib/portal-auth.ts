/**
 * Portal Auth — fully independent of Auth.js (auth.ts).
 *
 * Portal sessions and Auth.js sessions are intentionally non-interoperable.
 * Do not attempt to unify them. Different cookie name, different token
 * format (opaque + DB-hashed, not JWT), different tables, different code
 * path end to end. See ADR: Claude/compass-portal-auth-adr-2026-07-03.md.
 *
 * Nothing under app/[orgSlug]/, app/api/mcp, or app/api/admin should ever
 * import from this file.
 */
import { randomBytes, createHash } from "crypto";
import { cookies } from "next/headers";
import getPrisma from "@/lib/db";

export const PORTAL_SESSION_COOKIE = "compass_portal_session";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Normalizes a portal-facing email for storage/lookup: trim + lowercase. */
export function normalizePortalEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Creates a new PortalSession row for the given account, sets the
 * compass_portal_session cookie, and returns the raw (unhashed) token.
 * Only the hash is ever persisted — mirrors the ApiKey.keyHash precedent.
 */
export async function createPortalSession(portalAccountId: string): Promise<string> {
  const rawToken = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  const prisma = getPrisma();
  await prisma.portalSession.create({
    data: {
      portalAccountId,
      tokenHash,
      expiresAt,
    },
  });

  const cookieStore = await cookies();
  cookieStore.set(PORTAL_SESSION_COOKIE, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return rawToken;
}

/**
 * Reads the compass_portal_session cookie (if present), hashes it, and
 * looks up a matching, unexpired PortalSession. Fails closed: any absence,
 * mismatch, or expiry returns null rather than throwing.
 */
export async function getPortalSession(): Promise<{ portalAccountId: string; email: string } | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value;
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const prisma = getPrisma();

  const session = await prisma.portalSession.findUnique({
    where: { tokenHash },
    select: {
      portalAccountId: true,
      expiresAt: true,
      portalAccount: { select: { email: true } },
    },
  });

  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;

  // Bump lastUsedAt on successful use (sliding expiry bookkeeping).
  await prisma.portalSession.update({
    where: { tokenHash },
    data: { lastUsedAt: new Date() },
  });

  return { portalAccountId: session.portalAccountId, email: session.portalAccount.email };
}

/**
 * Deletes the current PortalSession row (if any) and always clears the
 * cookie, regardless of whether a matching row was found.
 */
export async function clearPortalSession(): Promise<void> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(PORTAL_SESSION_COOKIE)?.value;

  if (rawToken) {
    const tokenHash = hashToken(rawToken);
    const prisma = getPrisma();
    await prisma.portalSession.deleteMany({ where: { tokenHash } });
  }

  cookieStore.delete(PORTAL_SESSION_COOKIE);
}
