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
// Shared by grantWorkspaceAgent (admin, direct) and approveAgentAccessRequest
// (admin, approving a self-serve AgentAccessRequest) so there is exactly one
// place that upserts an AgentWorkspaceGrant — never a second grant pathway.
async function applyWorkspaceGrant(prisma: ReturnType<typeof getPrisma>, workspaceId: string, agentId: string, access: "READ" | "WRITE", grantedByUserId: string) {
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
    const data = { access, grantedByUserId, revokedAt: null, updatedAt: new Date() };
    await tx.agentWorkspaceGrant.upsert({ where: { agentId_workspaceId: { agentId, workspaceId } }, create: { agentId, workspaceId, ...data }, update: data });
  });
}
export async function grantWorkspaceAgent(orgSlug: string, workspaceSlug: string, agentId: string, access: "READ" | "WRITE") {
  const { userId } = await account();
  requireEnabled();
  if (access !== "READ" && access !== "WRITE") throw new Error("Invalid access");
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  await applyWorkspaceGrant(prisma, workspaceId, agentId, access, userId);
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}
export async function revokeWorkspaceAgent(orgSlug: string, workspaceSlug: string, agentId: string) {
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  await prisma.agentWorkspaceGrant.updateMany({ where: { workspaceId, agentId, revokedAt: null }, data: { revokedAt: new Date(), updatedAt: new Date() } });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}

// ─── Self-service access requests (Compass solution 538d6df0) ──────────────
// The agent owner — already an ordinary WorkspaceMember — asks for access
// instead of an admin creating the AgentWorkspaceGrant blind from workspace
// settings. Approve/deny live here (not in the workspace settings actions
// file) because they share `account()`/`requireEnabled()`/`applyWorkspaceGrant`
// with the rest of this module's agent-account operations.

export async function requestAgentAccess(agentId: string, workspaceId: string, access: "READ" | "WRITE") {
  const { prisma, userId } = await account();
  requireEnabled();
  if (access !== "READ" && access !== "WRITE") throw new Error("Invalid access");
  const agent = await prisma.agent.findFirst({ where: { id: agentId, ownerUserId: userId } });
  if (!agent) throw new Error("Agent not found");
  if (agent.status !== "ACTIVE") throw new Error("Agent is suspended");
  const member = await prisma.workspaceMember.findFirst({ where: { workspaceId, userId }, select: { id: true } });
  if (!member) throw new Error("You must be a member of this workspace to request access");
  const activeGrant = await prisma.agentWorkspaceGrant.findFirst({ where: { agentId, workspaceId, revokedAt: null }, select: { id: true } });
  if (activeGrant) throw new Error("This agent already has access to this workspace");
  const pending = await prisma.agentAccessRequest.findFirst({ where: { agentId, workspaceId, status: "PENDING" }, select: { id: true } });
  if (pending) throw new Error("A request for this workspace is already pending");
  const request = await prisma.agentAccessRequest.create({ data: { agentId, workspaceId, requestedAccess: access, requestedByUserId: userId, status: "PENDING", updatedAt: new Date() } });
  revalidatePath("/settings/agents");
  return request;
}

async function resolvePendingRequestWorkspace(prisma: ReturnType<typeof getPrisma>, requestId: string) {
  const request = await prisma.agentAccessRequest.findFirst({ where: { id: requestId, status: "PENDING" } });
  if (!request) throw new Error("Request not found");
  const workspace = await prisma.workspace.findUnique({ where: { id: request.workspaceId }, select: { slug: true, organization: { select: { slug: true } } } });
  if (!workspace) throw new Error("Workspace not found");
  return { request, orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug };
}

export async function approveAgentAccessRequest(requestId: string) {
  const { prisma: accountPrisma, userId } = await account();
  requireEnabled();
  const { request, orgSlug, workspaceSlug } = await resolvePendingRequestWorkspace(accountPrisma, requestId);
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  await applyWorkspaceGrant(prisma, workspaceId, request.agentId, request.requestedAccess as "READ" | "WRITE", userId);
  await prisma.agentAccessRequest.update({ where: { id: requestId }, data: { status: "APPROVED", decidedByUserId: userId, decidedAt: new Date(), updatedAt: new Date() } });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}

export async function denyAgentAccessRequest(requestId: string) {
  const { prisma: accountPrisma, userId } = await account();
  const { orgSlug, workspaceSlug } = await resolvePendingRequestWorkspace(accountPrisma, requestId);
  const { prisma } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  await prisma.agentAccessRequest.update({ where: { id: requestId }, data: { status: "DENIED", decidedByUserId: userId, decidedAt: new Date(), updatedAt: new Date() } });
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}
