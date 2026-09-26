"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { resolveWorkspaceAdmin } from "@/lib/permissions";
import { agentsEnabled } from "@/lib/agent-access";

async function account() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");
  return { prisma: getPrisma(), userId: session.user.id };
}
function requireEnabled() {
  if (!agentsEnabled()) throw new Error("Agent changes are currently disabled");
}
function nameValue(value: string) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) throw new Error("Name must contain 1–120 characters");
  return value.trim();
}
function descriptionValue(value?: string) {
  if (value !== undefined && (typeof value !== "string" || value.length > 2000)) throw new Error("Description must be at most 2000 characters");
  return value?.trim() || null;
}
export async function createAgent(input: { name: string; description?: string }) {
  const { prisma, userId } = await account();
  requireEnabled();
  const agent = await prisma.agent.create({ data: { ownerUserId: userId, name: nameValue(input.name), description: descriptionValue(input.description), status: "ACTIVE", updatedAt: new Date() } });
  revalidatePath("/settings/agents");
  return agent;
}
export async function updateAgent(id: string, input: { name: string; description?: string; status: "ACTIVE" | "SUSPENDED" }) {
  const { prisma, userId } = await account();
  if (input.status !== "ACTIVE" && input.status !== "SUSPENDED") throw new Error("Invalid agent status");
  if (input.status === "ACTIVE") requireEnabled();
  const agent = await prisma.agent.findFirst({ where: { id, ownerUserId: userId } });
  if (!agent) throw new Error("Agent not found");
  await prisma.agent.update({ where: { id }, data: { name: nameValue(input.name), description: descriptionValue(input.description), status: input.status, updatedAt: new Date() } });
  revalidatePath("/settings/agents");
}
export async function createAgentKey(agentId: string, input: { name: string; expiresAt?: string }) {
  const { prisma, userId } = await account();
  requireEnabled();
  const agent = await prisma.agent.findFirst({ where: { id: agentId, ownerUserId: userId } });
  if (!agent) throw new Error("Agent not found");
  if (agent.status !== "ACTIVE") throw new Error("Agent is suspended");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date())) throw new Error("Expiry must be a valid future date");
  const rawKey = `cmp_${randomBytes(16).toString("hex")}`;
  const key = await prisma.apiKey.create({ data: { userId, agentId, purpose: "AGENT", name: nameValue(input.name), keyHash: createHash("sha256").update(rawKey).digest("hex"), keyPrefix: rawKey.slice(4, 12), expiresAt }, select: { id: true } });
  revalidatePath("/settings/agents");
  return { id: key.id, rawKey };
}
export async function revokeAgentKey(id: string) {
  const { prisma, userId } = await account();
  const key = await prisma.apiKey.findFirst({ where: { id, userId, purpose: "AGENT" }, select: { id: true } });
  if (!key) throw new Error("Key not found");
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  revalidatePath("/settings/agents");
}
export async function grantWorkspaceAgent(orgSlug: string, workspaceSlug: string, agentId: string, access: "READ" | "WRITE") {
  const { userId } = await account();
  requireEnabled();
  if (access !== "READ" && access !== "WRITE") throw new Error("Invalid access");
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  const agent = await prisma.agent.findFirst({ where: { id: agentId, status: "ACTIVE" } });
  if (!agent) throw new Error("Agent not found");
  await prisma.$transaction(async (tx) => {
    const member = await tx.workspaceMember.findFirst({ where: { workspaceId, userId: agent.ownerUserId }, select: { id: true, role: true } });
    if (!member) throw new Error("Agent owner must be a current workspace member");
    // Touch the membership row so DSQL rejects a concurrent membership delete.
    // Without this write, a grant could commit after removal and revive on rejoin.
    // Compare the role as well: a concurrent demotion must never be overwritten
    // by the role read before waiting for PostgreSQL's row lock.
    const locked = await tx.workspaceMember.updateMany({ where: { id: member.id, role: member.role }, data: { role: member.role } });
    if (locked.count !== 1) throw new Error("Membership changed; retry the operation");
    const data = { access, grantedByUserId: userId, revokedAt: null, updatedAt: new Date() };
    await tx.agentWorkspaceGrant.upsert({ where: { agentId_workspaceId: { agentId, workspaceId } }, create: { agentId, workspaceId, ...data }, update: data });
  });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}
export async function revokeWorkspaceAgent(orgSlug: string, workspaceSlug: string, agentId: string) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  await prisma.agentWorkspaceGrant.updateMany({ where: { workspaceId, agentId, revokedAt: null }, data: { revokedAt: new Date(), updatedAt: new Date() } });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}

async function removeOAuthConnection(consentId: string) {
  const { prisma, userId } = await account();
  await prisma.$transaction(async (tx) => {
    // Resolve the client only through an account-scoped consent lookup. The
    // caller controls consentId, so looking it up by id alone would let one
    // account revoke another account's token families.
    const consent = await tx.oAuthConsent.findFirst({
      where: { id: consentId, userId },
      select: { id: true, clientId: true },
    });
    if (!consent) throw new Error("Connection not found");

    const revokedAt = new Date();
    // A connection may have several token families after repeated grants.
    // End every live family for this account/client, while retaining the
    // account predicate even though family ids should already be unique.
    await tx.oAuthToken.updateMany({
      where: { userId, clientId: consent.clientId, revokedAt: null },
      data: { revokedAt },
    });
    // A code is a credential-to-be. Remove it in the same transaction so a
    // grant started before Revoke/Reconnect cannot mint a new family afterward.
    await tx.oAuthAuthorizationCode.deleteMany({
      where: { userId, clientId: consent.clientId, consumedAt: null },
    });
    // Revocation removes remembered permission too. Reconnect relies on this
    // same deletion specifically so the next authorization cannot replay the
    // old agent/full-account binding.
    await tx.oAuthConsent.deleteMany({
      where: { id: consent.id, userId, clientId: consent.clientId },
    });
  });
  revalidatePath("/settings/agents");
}

/** End an account-owned OAuth connection and invalidate all of its token families. */
export async function revokeOAuthConnection(consentId: string) {
  await removeOAuthConnection(consentId);
}

/** Force the next client authorization to ask for a new agent/account binding. */
export async function reconnectOAuthConnection(consentId: string) {
  await removeOAuthConnection(consentId);
}
