// One-time-ops admin endpoint: regenerates a workspace's SSO Identify shared
// secret and returns the raw value.
//
// Why this exists: the raw secret is only ever shown once, at generation
// time, in Settings → Portal → SSO Identify (see regenerateSsoSecret in
// app/[orgSlug]/[workspaceSlug]/settings/actions.ts). If a customer
// integration's copy ever drifts out of sync with what's in our DB (e.g.
// the secret gets regenerated for any reason after the customer already
// wired it in), there is normally no way to recover the current value
// without an interactive Settings login — this endpoint gives us a
// server-to-server way to force a fresh, known value and hand it back
// immediately, so both sides can be resynced in one step.
//
// POST /api/admin/portal-sso-resync
// Headers: x-migration-secret: <MIGRATION_SECRET>
// Body: { orgSlug: string, workspaceSlug: string }
//
// Same trust boundary as /api/admin/migrate — protected by MIGRATION_SECRET,
// not a session. Bypasses the membership check in resolveWorkspace() (in
// actions.ts) on purpose: this is meant to be called outside any user
// session, e.g. by us directly after diagnosing a broken integration.

import { NextRequest, NextResponse } from "next/server";
import getPrisma from "@/lib/db";
import { generateSsoSecret } from "@/lib/portal-sso";
import { encrypt } from "@/lib/crypto-secrets";

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET;
  if (!secret) return false;
  return req.headers.get("x-migration-secret") === secret;
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgSlug = body?.orgSlug;
  const workspaceSlug = body?.workspaceSlug;
  if (typeof orgSlug !== "string" || typeof workspaceSlug !== "string") {
    return NextResponse.json(
      { error: "orgSlug and workspaceSlug are required" },
      { status: 400 }
    );
  }

  const prisma = getPrisma();
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug } },
    select: { id: true },
  });
  if (!workspace) {
    return NextResponse.json(
      { error: `No workspace found for ${orgSlug}/${workspaceSlug}` },
      { status: 404 }
    );
  }

  const encryptionKey = process.env.SSO_SECRET_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return NextResponse.json(
      { error: "SSO_SECRET_ENCRYPTION_KEY is not configured on the server" },
      { status: 500 }
    );
  }

  const rawSecret = generateSsoSecret();
  const ssoSecretEncrypted = encrypt(rawSecret, encryptionKey);

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      ssoEnabled: true,
      ssoSecretEncrypted,
      ssoSecretUpdatedAt: new Date(),
    },
  });

  return NextResponse.json({ rawSecret });
}
