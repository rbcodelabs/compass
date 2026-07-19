import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { decrypt } from "@/lib/crypto-secrets";
import { verifySsoToken } from "@/lib/portal-sso";
import { createPortalSession, normalizePortalEmail } from "@/lib/portal-auth";

type Params = { orgSlug: string; workspaceSlug: string };

/** Only allow relative /portal/... redirect targets — no open redirect. Mirrors app/api/portal/auth/verify/route.ts. */
function sanitizeReturnTo(returnTo: string | null): string | null {
  if (!returnTo) return null;
  if (!returnTo.startsWith("/portal/")) return null;
  if (returnTo.startsWith("//")) return null;
  return returnTo;
}

function htmlResponse(body: string, status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="font-family: sans-serif; text-align: center; padding: 4rem 1rem;">${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<Params> }
) {
  const { orgSlug, workspaceSlug } = await params;

  const token = req.nextUrl.searchParams.get("token");
  // Re-validate returnTo server-side — don't trust the round-tripped query
  // param blindly, same reasoning as auth/verify/route.ts.
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("returnTo"));

  if (!token) {
    return htmlResponse("<p>This sign-in link is invalid.</p>", 400);
  }

  const prisma = getPrisma();

  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true, ssoEnabled: true, ssoSecretEncrypted: true },
  });

  if (!workspace) {
    return htmlResponse("<p>Workspace not found.</p>", 404);
  }

  if (!workspace.ssoEnabled || !workspace.ssoSecretEncrypted) {
    return htmlResponse("<p>SSO Identify is not enabled for this workspace.</p>", 400);
  }

  const encryptionKey = process.env.SSO_SECRET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    // Server misconfiguration, not a client error — fail closed either way.
    console.error("[portal-sso] SSO_SECRET_ENCRYPTION_KEY is not set");
    return htmlResponse("<p>SSO Identify is temporarily unavailable.</p>", 500);
  }

  let secret: string;
  try {
    secret = decrypt(workspace.ssoSecretEncrypted, encryptionKey);
  } catch {
    // Ciphertext doesn't decrypt under the current key (e.g. key rotated
    // out from under stored secrets) — fail closed, never crash the route.
    console.error(`[portal-sso] Failed to decrypt SSO secret for workspace ${workspace.id}`);
    return htmlResponse("<p>SSO Identify is temporarily unavailable.</p>", 500);
  }

  const identity = await verifySsoToken(secret, token);

  if (!identity) {
    return htmlResponse(
      "<p>This sign-in link is invalid, expired, or has an invalid signature.</p>",
      400
    );
  }

  const email = normalizePortalEmail(identity.email);

  const portalAccount = await prisma.portalAccount.upsert({
    where: { email },
    update: {
      ...(identity.name ? { name: identity.name } : {}),
    },
    create: {
      email,
      name: identity.name ?? null,
      emailVerified: new Date(),
    },
  });

  await createPortalSession(portalAccount.id);

  if (returnTo) {
    return NextResponse.redirect(new URL(returnTo, req.nextUrl.origin));
  }

  return htmlResponse(
    `<p>Signed in as ${portalAccount.email}. You can close this tab.</p>`,
    200
  );
}
