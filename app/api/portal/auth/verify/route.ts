import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import getPrisma from "@/lib/db";
import { createPortalSession } from "@/lib/portal-auth";

/** Only allow relative /portal/... redirect targets — no open redirect. */
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

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  // Re-validate returnTo server-side — don't trust the round-tripped query
  // param blindly, even though /send already validated it once.
  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("returnTo"));

  if (!token) {
    return htmlResponse("<p>This sign-in link is invalid.</p>", 400);
  }

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const prisma = getPrisma();

  const verification = await prisma.portalVerificationToken.findUnique({
    where: { tokenHash },
  });

  if (!verification) {
    return htmlResponse("<p>This sign-in link is invalid or has already been used.</p>", 400);
  }

  // Single-use: delete immediately, before doing anything else.
  await prisma.portalVerificationToken.delete({ where: { tokenHash } });

  if (verification.expiresAt.getTime() < Date.now()) {
    return htmlResponse("<p>This sign-in link has expired. Please request a new one.</p>", 400);
  }

  const portalAccount = await prisma.portalAccount.upsert({
    where: { email: verification.email },
    update: {},
    create: { email: verification.email, emailVerified: new Date() },
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
