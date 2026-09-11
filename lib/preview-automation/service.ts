import { randomBytes, randomUUID } from "node:crypto";
import type { PreviewAutomationRun } from "@prisma/client";
import type { AppPrismaClient, AppTransactionClient } from "@/lib/db";
import type { PreviewGrant } from "./grants";
import { applyPreviewScenario, DEFAULT_PREVIEW_SCENARIO } from "./scenarios";
import { getActiveSchema } from "@/lib/schema";
import { deleteWorkspaceCascade } from "@/lib/delete-workspace-cascade";
import { deleteWorkspaceResearchData } from "@/lib/research-workspace-cleanup";

export { PREVIEW_SESSION_COOKIE, PREVIEW_SESSION_OPTIONS } from "./cookies";
/** Revoke first. Retain the registry tombstone so failures can safely retry exact ownership. */
export async function cleanupPreviewRun(prisma: AppPrismaClient, runId: string, deploymentId: string) {
  const result = { runId, cleaned: true };
  const run = await prisma.previewAutomationRun.findUnique({ where: { id: runId } });
  if (!run) return result;
  if (run.deploymentId !== deploymentId) throw new Error("Preview run deployment mismatch");
  if (run.cleanedAt) return result;
  await prisma.previewAutomationRun.update({ where: { id: runId }, data: { revokedAt: run.revokedAt ?? new Date() } });
  const userIds = [run.ownerUserId, run.viewerUserId];
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.previewAutomationSession.deleteMany({ where: { runId } });
  for (const workspaceId of [run.workspaceId, run.isolatedWorkspaceId]) {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) continue;
    if (workspace.organizationId !== run.orgId) throw new Error("Preview workspace ownership mismatch");
    // Blob-backed workflows are not a v1 fixture. Preserve unexpected blobs for explicit review;
    // never let a synthetic run trigger the schema-wide external cleanup queue.
    if (await prisma.artifactRevision.count({ where: { artifact: { workspaceId }, blobPathname: { not: null } } }) ||
      await prisma.researchAttachment.count({ where: { workspaceId } })) throw new Error("Preview cleanup requires blob review");
    await prisma.docCommentAnchor.deleteMany({ where: { comment: { workspaceId } } });
    await prisma.solutionPlanProposal.deleteMany({ where: { comment: { workspaceId } } });
    await prisma.comment.updateMany({ where: { workspaceId }, data: { parentId: null } });
    await prisma.comment.deleteMany({ where: { workspaceId } });
    await prisma.docComment.updateMany({ where: { doc: { workspaceId } }, data: { parentId: null } });
    await prisma.docComment.deleteMany({ where: { doc: { workspaceId } } });
    await prisma.docVersion.deleteMany({ where: { doc: { workspaceId } } });
    await prisma.agentMessage.deleteMany({ where: { conversation: { workspaceId } } });
    await prisma.agentConversation.deleteMany({ where: { workspaceId } });
    await prisma.agentAuditLog.deleteMany({ where: { workspaceId } });
    await deleteWorkspaceResearchData(prisma, workspaceId);
    await prisma.nowPolicyApplicationEvidence.deleteMany({ where: { workspaceId } });
    await prisma.nowGateEvaluation.deleteMany({ where: { workspaceId } });
    await prisma.portfolioCapacityOperation.deleteMany({ where: { workspaceId } });
    await deleteWorkspaceCascade(prisma, workspaceId, { skipBlobCleanup: true });
  }
  await prisma.scoringModelMetric.deleteMany({ where: { scoringModel: { organizationId: run.orgId } } });
  await prisma.scoringModel.deleteMany({ where: { organizationId: run.orgId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: run.orgId } });
  await prisma.organization.deleteMany({ where: { id: run.orgId } });
  await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.apiKey.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.previewAutomationRun.update({ where: { id: runId }, data: { cleanedAt: new Date() } });
  return result;
}

export async function teardownPreviewRun(prisma: AppPrismaClient, grant: PreviewGrant) {
  await prisma.$transaction(async (tx) => {
    await consume(tx, grant);
    const run = await tx.previewAutomationRun.findUnique({ where: { id: grant.runId } });
    if (run && run.deploymentId !== grant.deploymentId) throw new Error("Preview run deployment mismatch");
    if (run) await tx.previewAutomationRun.update({ where: { id: run.id }, data: { revokedAt: run.revokedAt ?? new Date() } });
    else {
      // Cancellation may arrive before bootstrap commits. This same-PK tombstone
      // prevents a delayed bootstrap from creating a live run after teardown succeeds.
      const now = new Date();
      await tx.previewAutomationRun.create({ data: {
        id: grant.runId, deploymentId: grant.deploymentId, orgId: randomUUID(), workspaceId: randomUUID(),
        isolatedWorkspaceId: randomUUID(), ownerUserId: randomUUID(), viewerUserId: randomUUID(),
        expiresAt: now, revokedAt: now, cleanedAt: now,
      } });
    }
  });
  return cleanupPreviewRun(prisma, grant.runId, grant.deploymentId);
}

async function consume(tx: AppTransactionClient, grant: PreviewGrant) {
  await tx.previewAutomationNonce.create({ data: { nonce: grant.nonce, runId: grant.runId, expiresAt: new Date(grant.exp * 1000) } });
}
function requireActive(run: PreviewAutomationRun | null, deploymentId: string, now: Date): asserts run is PreviewAutomationRun {
  if (!run || run.deploymentId !== deploymentId || run.revokedAt || run.expiresAt <= now) throw new Error("Preview run unavailable");
}
function describeRun(run: PreviewAutomationRun) {
  return { runId: run.id, orgSlug: `preview-${run.id}`, workspaceSlug: "workspace", isolatedWorkspaceSlug: "isolated", expiresAt: run.expiresAt.toISOString() };
}

/** Nonce + registry + all fixtures commit together; a lost response can retry with a fresh grant. */
export async function bootstrapPreviewRun(prisma: AppPrismaClient, grant: PreviewGrant, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await consume(tx, grant);
    const existing = await tx.previewAutomationRun.findUnique({ where: { id: grant.runId } });
    if (existing) { requireActive(existing, grant.deploymentId, now); return describeRun(existing); }
    const run = await tx.previewAutomationRun.create({ data: {
      id: grant.runId, deploymentId: grant.deploymentId, orgId: randomUUID(), workspaceId: randomUUID(),
      isolatedWorkspaceId: randomUUID(), ownerUserId: randomUUID(), viewerUserId: randomUUID(),
      expiresAt: new Date(now.getTime() + 3600000), createdAt: now,
    } });
    await tx.user.createMany({ data: [
      { id: run.ownerUserId, name: "Preview Owner", email: `owner-${run.id}@preview.invalid`, emailVerified: now },
      { id: run.viewerUserId, name: "Preview Member", email: `member-${run.id}@preview.invalid`, emailVerified: now },
    ] });
    await tx.organization.create({ data: { id: run.orgId, slug: `preview-${run.id}`, name: "Preview validation" } });
    await tx.workspace.createMany({ data: [
      { id: run.workspaceId, organizationId: run.orgId, slug: "workspace", name: "Preview workspace" },
      { id: run.isolatedWorkspaceId, organizationId: run.orgId, slug: "isolated", name: "Isolated workspace" },
    ] });
    await tx.organizationMember.createMany({ data: [
      { organizationId: run.orgId, userId: run.ownerUserId, role: "OWNER" },
      { organizationId: run.orgId, userId: run.viewerUserId, role: "MEMBER" },
    ] });
    await tx.workspaceMember.createMany({ data: [
      { workspaceId: run.workspaceId, userId: run.ownerUserId, role: "ADMIN" },
      { workspaceId: run.workspaceId, userId: run.viewerUserId, role: "MEMBER" },
    ] });
    // Same transaction as the registry row, so fixtures are never orphaned
    // from the run that owns their teardown. Only the primary workspace is
    // seeded: the isolated one must stay empty for cross-workspace denial
    // checks. The default scenario writes nothing, keeping previously
    // signed grants on exactly the fixture they bootstrap today.
    const scenario = grant.scenario ?? DEFAULT_PREVIEW_SCENARIO;
    if (scenario !== DEFAULT_PREVIEW_SCENARIO) {
      await applyPreviewScenario(tx, { schema: getActiveSchema(), workspaceId: run.workspaceId, scenario });
    }
    return describeRun(run);
  });
}

export async function issuePreviewSession(prisma: AppPrismaClient, grant: PreviewGrant, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    await consume(tx, grant);
    const run = await tx.previewAutomationRun.findUnique({ where: { id: grant.runId } });
    requireActive(run, grant.deploymentId, now);
    if (grant.persona !== "owner" && grant.persona !== "viewer") throw new Error("Invalid preview persona");
    // A real write to the same row as revocation makes DSQL's optimistic concurrency
    // reject an issuance racing teardown, rather than committing orphaned sessions.
    const locked = await tx.previewAutomationRun.updateMany({ where: { id: run.id, revokedAt: null, expiresAt: { gt: now } }, data: { sessionNonce: grant.nonce } });
    if (locked.count !== 1) throw new Error("Preview run unavailable");
    const sessionToken = `preview_${randomBytes(32).toString("base64url")}`;
    await tx.session.create({ data: { sessionToken, userId: grant.persona === "owner" ? run.ownerUserId : run.viewerUserId, expires: run.expiresAt } });
    await tx.previewAutomationSession.create({ data: { sessionToken, runId: run.id } });
    return { sessionToken, expiresAt: run.expiresAt };
  });
}
