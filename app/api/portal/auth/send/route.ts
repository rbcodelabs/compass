import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import getPrisma from "@/lib/db";
import { normalizePortalEmail } from "@/lib/portal-auth";
import { isValidPortalEmail } from "@/lib/portal-email";
import { e2eMockAuthEnabled } from "@/lib/e2e-harness";
import { EmbedSourceError, resolveEmbedToken } from "@/lib/embed-sources";

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

/** Only allow relative /portal/... redirect targets — no open redirect. */
function sanitizeReturnTo(returnTo: unknown): string | null {
  if (typeof returnTo !== "string") return null;
  if (!returnTo.startsWith("/portal/")) return null;
  if (returnTo.startsWith("//")) return null;
  return returnTo;
}

/**
 * The workspace this sign-in is for, or null when it cannot be told.
 *
 * A portal session is bound to the workspace that issued it, so a link must be
 * requested *for* one. It comes from one of two server-checked places, never a
 * bare id the client names: the portal path (`/portal/<org>/<workspace>/...`,
 * the same value `returnTo` already carries), or an embed token, which
 * resolves to its feedback source's workspace.
 */
async function resolveSignInWorkspaceId(
  prisma: ReturnType<typeof getPrisma>,
  returnTo: string | null,
  embedToken: unknown
): Promise<string | null> {
  if (typeof embedToken === "string" && embedToken) {
    try {
      return (await resolveEmbedToken(embedToken)).workspaceId;
    } catch (error) {
      if (error instanceof EmbedSourceError) return null;
      throw error;
    }
  }
  if (!returnTo) return null;
  const [, , orgSlug, workspaceSlug] = returnTo.split(/[?#]/)[0].split("/");
  if (!orgSlug || !workspaceSlug) return null;
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  return workspace?.id ?? null;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email, returnTo, embedToken } = body as Record<string, unknown>;

  if (!email || typeof email !== "string" || !isValidPortalEmail(email)) {
    return NextResponse.json({ error: "A valid email address is required" }, { status: 422 });
  }

  // Fail closed in production when there is no mail transport: a link we cannot
  // deliver must not be minted, and must never be surfaced anywhere else.
  // The e2e production build (lib/e2e-harness.ts) has no mail transport by design and reads the link from the response below;
  // that is allowed only there, never in a deployed build (inline build literal: the branch is removed from every other artifact).
  const e2eMockBuild = process.env.COMPASS_E2E_MOCK_AUTH_BUILD === "1" && e2eMockAuthEnabled();
  if (!process.env.AUTH_RESEND_KEY && process.env.NODE_ENV === "production" && !e2eMockBuild) {
    console.error("[portal-auth] Sign-in email is not configured");
    return NextResponse.json({ error: "Sign-in email is temporarily unavailable" }, { status: 503 });
  }

  const normalizedEmail = normalizePortalEmail(email);
  const safeReturnTo = sanitizeReturnTo(returnTo);

  const prisma = getPrisma();

  const workspaceId = await resolveSignInWorkspaceId(prisma, safeReturnTo, embedToken);
  if (!workspaceId) {
    return NextResponse.json({ error: "Sign-in must be started from a workspace portal" }, { status: 422 });
  }

  // Per-email throttle: don't send a second link while a valid one is live.
  // Always return the same generic success response either way — no
  // account-enumeration oracle, and no inbox-bombing a real third party.
  const existing = await prisma.portalVerificationToken.findFirst({
    where: { email: normalizedEmail, workspaceId, expiresAt: { gt: new Date() } },
    select: { id: true },
  });

  // Only ever populated outside production, and only in the no-Resend-key
  // dev branch below — never leaks a usable token when real email sending
  // is configured. The DB itself only ever stores tokenHash (never the raw
  // token, mirroring ApiKey.keyHash) — this is the one intentional escape
  // hatch for local dev tooling (get-portal-magic-link.ts) and E2E tests.
  let devVerifyUrl: string | undefined;

  if (!existing) {
    const rawToken = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await prisma.portalVerificationToken.create({
      data: { email: normalizedEmail, workspaceId, tokenHash, expiresAt },
    });

    // Delete the just-created token when the email could not be sent, so the
    // per-email throttle does not block the user's retry for 15 minutes.
    const discardUnsentToken = () =>
      prisma.portalVerificationToken.delete({ where: { tokenHash } }).catch(() => undefined);

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const verifyUrl = new URL("/api/portal/auth/verify", appUrl);
    verifyUrl.searchParams.set("token", rawToken);
    if (safeReturnTo) verifyUrl.searchParams.set("returnTo", safeReturnTo);

    if (!process.env.AUTH_RESEND_KEY) {
      // Dev/test convenience (production returned 503 above): no Resend key
      // configured, so hand the link back in the response. It is never logged.
      devVerifyUrl = verifyUrl.toString();
    } else {
      let sent = false;
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.AUTH_RESEND_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: process.env.AUTH_EMAIL_FROM ?? "Compass <noreply@compass.app>",
            to: normalizedEmail,
            subject: "Sign in to Compass",
            html: `<p>Click the link below to sign in and continue:</p><p><a href="${verifyUrl.toString()}">Sign in to Compass</a></p><p>This link expires in 15 minutes.</p>`,
          }),
        });
        sent = res.ok;
        if (!res.ok) console.error(`[portal-auth] Email provider rejected sign-in email (status ${res.status})`);
      } catch {
        console.error("[portal-auth] Email provider request failed");
      }
      if (!sent) {
        await discardUnsentToken();
        return NextResponse.json({ error: "Could not send the sign-in email" }, { status: 502 });
      }
    }
  }

  return NextResponse.json({ success: true, ...(devVerifyUrl ? { devVerifyUrl } : {}) });
}
