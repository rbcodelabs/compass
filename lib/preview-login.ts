import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import { applyPreviewScenario } from "./preview-automation/scenarios";
import { getActiveSchema } from "./schema";

/**
 * ADR-0009: a separate, additive human-exploration login for opted-in
 * preview branches. Distinct trust boundary from lib/preview-automation/* —
 * this rides the existing shared `compass_preview` schema and ordinary
 * Auth.js database sessions, not the per-PR isolated-schema/signed-grant
 * system. See docs/decisions/0009-preview-login.md.
 *
 * Closed catalog, mirroring how preview-automation's personas/scenarios are
 * never accepted as arbitrary client-supplied values.
 */
export const PREVIEW_LOGIN_PERSONAS = ["owner", "viewer"] as const;
export type PreviewLoginPersona = (typeof PREVIEW_LOGIN_PERSONAS)[number];

export function isPreviewLoginPersona(value: unknown): value is PreviewLoginPersona {
  return typeof value === "string" && (PREVIEW_LOGIN_PERSONAS as readonly string[]).includes(value);
}

const SAMPLE_ORG_SLUG = "preview-sample";
const SAMPLE_WORKSPACE_SLUG = "workspace";
const SAMPLE_OWNER_EMAIL = "preview-owner@preview.invalid";
const SAMPLE_VIEWER_EMAIL = "preview-viewer@preview.invalid";
const SESSION_TOKEN_PREFIX = "previewlogin_";
/** Hard cap — intentionally not configurable. Do not widen. */
const SESSION_DURATION_MS = 60 * 60 * 1000;

/**
 * Cheap, fails-before-anything-else check — mirror the "fail before DB
 * access" style of lib/preview-automation/handler.ts. Both conditions are
 * required together: this must never be reachable on production, and it
 * must stay off on every preview branch that hasn't explicitly opted in.
 */
export function isPreviewLoginEnabled(): boolean {
  return process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_LOGIN_ENABLED === "1";
}

/**
 * Constant-time access-code check. Both sides are hashed to a fixed-length
 * digest before comparison so a length mismatch on the submitted value can
 * never throw or leak timing about the real code's length. An unset or
 * empty PREVIEW_LOGIN_ACCESS_CODE fails closed — there is no codeless
 * bypass, even if PREVIEW_LOGIN_ENABLED=1.
 */
export function verifyPreviewLoginAccessCode(submitted: unknown): boolean {
  const expected = process.env.PREVIEW_LOGIN_ACCESS_CODE;
  if (!expected) return false;
  if (typeof submitted !== "string" || submitted.length === 0) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const submittedDigest = createHash("sha256").update(submitted).digest();
  return timingSafeEqual(expectedDigest, submittedDigest);
}

export interface SampleWorkspace {
  orgSlug: string;
  workspaceSlug: string;
  ownerUserId: string;
  viewerUserId: string;
}

async function lookupSampleWorkspace(
  prisma: Pick<AppPrismaClient, "organization" | "workspace" | "user">
): Promise<SampleWorkspace | null> {
  const org = await prisma.organization.findUnique({ where: { slug: SAMPLE_ORG_SLUG } });
  if (!org) return null;
  const [workspace, ownerUser, viewerUser] = await Promise.all([
    prisma.workspace.findFirst({ where: { organizationId: org.id, slug: SAMPLE_WORKSPACE_SLUG } }),
    prisma.user.findUnique({ where: { email: SAMPLE_OWNER_EMAIL } }),
    prisma.user.findUnique({ where: { email: SAMPLE_VIEWER_EMAIL } }),
  ]);
  if (!workspace || !ownerUser || !viewerUser) return null;
  return { orgSlug: org.slug, workspaceSlug: workspace.slug, ownerUserId: ownerUser.id, viewerUserId: viewerUser.id };
}

async function createSampleWorkspace(prisma: AppPrismaClient): Promise<SampleWorkspace> {
  return prisma.$transaction(async (tx: AppTransactionClient) => {
    const now = new Date();
    const org = await tx.organization.create({ data: { slug: SAMPLE_ORG_SLUG, name: "Preview Sample" } });
    const [ownerUser, viewerUser] = await Promise.all([
      tx.user.create({ data: { name: "Sample Workspace Admin", email: SAMPLE_OWNER_EMAIL, emailVerified: now } }),
      tx.user.create({ data: { name: "Sample Team Member", email: SAMPLE_VIEWER_EMAIL, emailVerified: now } }),
    ]);
    const workspace = await tx.workspace.create({ data: { organizationId: org.id, slug: SAMPLE_WORKSPACE_SLUG, name: "Sample Workspace" } });
    await tx.organizationMember.createMany({ data: [
      { organizationId: org.id, userId: ownerUser.id, role: "ADMIN" },
      { organizationId: org.id, userId: viewerUser.id, role: "MEMBER" },
    ] });
    await tx.workspaceMember.createMany({ data: [
      { workspaceId: workspace.id, userId: ownerUser.id, role: "ADMIN" },
      { workspaceId: workspace.id, userId: viewerUser.id, role: "MEMBER" },
    ] });
    // Same transaction as the registry rows above, so the seed can never
    // land partially applied: either the whole sample org+seed commits, or
    // none of it does.
    await applyPreviewScenario(tx, { schema: getActiveSchema(), workspaceId: workspace.id, scenario: "full-data" });
    return { orgSlug: org.slug, workspaceSlug: workspace.slug, ownerUserId: ownerUser.id, viewerUserId: viewerUser.id };
  });
}

/**
 * Idempotently ensures the fixed sample org/workspace exists and is seeded
 * exactly once. Safe to call on every login: if the org already exists,
 * creation and seeding are skipped entirely — the fixture builders reused
 * from lib/preview-automation/scenarios.ts are not designed to be applied
 * twice against the same workspace.
 */
export async function ensureSampleWorkspace(prisma: AppPrismaClient): Promise<SampleWorkspace> {
  const existing = await lookupSampleWorkspace(prisma);
  if (existing) return existing;
  try {
    return await createSampleWorkspace(prisma);
  } catch (error) {
    // Two logins can race this same idempotent creation (e.g. a double
    // form submit). If another request already committed the sample org,
    // resolve to it instead of surfacing a spurious unique-constraint error.
    const afterRace = await lookupSampleWorkspace(prisma);
    if (afterRace) return afterRace;
    throw error;
  }
}

export interface PreviewLoginSession {
  sessionToken: string;
  expiresAt: Date;
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * Issues a plain Auth.js database session for the resolved persona's
 * synthetic user. The `previewlogin_` prefix deliberately does not match
 * preview-automation's `preview_` prefix, so createLazyPrismaAuthAdapter's
 * automation special-case never sees this token — it falls through to the
 * adapter's ordinary, unmodified session handling.
 */
export async function issuePreviewLoginSession(
  prisma: AppPrismaClient,
  persona: PreviewLoginPersona,
  now = new Date()
): Promise<PreviewLoginSession> {
  const sample = await ensureSampleWorkspace(prisma);
  const userId = persona === "owner" ? sample.ownerUserId : sample.viewerUserId;
  const sessionToken = `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await prisma.session.create({ data: { sessionToken, userId, expires: expiresAt } });
  return { sessionToken, expiresAt, orgSlug: sample.orgSlug, workspaceSlug: sample.workspaceSlug };
}
