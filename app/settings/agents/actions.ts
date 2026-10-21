"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import getPrisma from "@/lib/db";
import { resolveWorkspaceAdmin } from "@/lib/permissions";
import { agentsEnabled, liveGrantedWorkspaceIds } from "@/lib/agent-access";
import { AGENT_LEGACY_SELECT, agentKind, agentOwner, canManageAgent, findAgentById, isUserOwnedBy, isWorkspaceAdminUser, type AgentInvokePolicy } from "@/lib/agent-ownership";
import { AgentSelectionError, resolveRunAgent } from "@/lib/agent-run-identity";
import { clearUserDefaultAgent, clearWorkspaceDefaultAgent, setUserDefaultAgent, setWorkspaceDefaultAgent } from "@/lib/agent-defaults";
import { parseAgentModel } from "@/lib/agent-models";

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
  const agent = await prisma.agent.create({ data: { ownerUserId: userId, name: nameValue(input.name), description: descriptionValue(input.description), status: "ACTIVE", updatedAt: new Date() }, select: AGENT_LEGACY_SELECT });
  revalidatePath("/settings/agents");
  return agent;
}
export async function updateAgent(id: string, input: { name: string; description?: string; status: "ACTIVE" | "SUSPENDED" }) {
  const { prisma, userId } = await account();
  if (input.status !== "ACTIVE" && input.status !== "SUSPENDED") throw new Error("Invalid agent status");
  if (input.status === "ACTIVE") requireEnabled();
  const agent = await findAgentById(prisma, id);
  if (!agent || !(await canManageAgent(prisma, { userId }, agent))) throw new Error("Agent not found");
  // select: the full row would include columns a database without migration 098 does not have.
  await prisma.agent.update({ where: { id }, data: { name: nameValue(input.name), description: descriptionValue(input.description), status: input.status, updatedAt: new Date() }, select: { id: true } });
  revalidatePath("/settings/agents");
}
// ── Cloud agents (ADR "Cloud agents as first-class identities", phase 3) ──────────────────────────────────────────────
// A cloud agent runs in Compass's sandbox with the instructions and model stored here. Creation rights follow the ADR: any
// workspace member creates a USER-owned (personal) agent; only a workspace administrator creates a WORKSPACE-owned (shared)
// one. Neither owner type can be chosen by the caller beyond what their role allows, and no input here selects a workspace the
// caller is not a member of: the workspace comes from the slugs, resolved against the caller's memberships.

const MAX_INSTRUCTIONS_LENGTH = 8000; // The turn route forwards at most this much; storing more would be silently cut.
const INVOKE_POLICIES: readonly AgentInvokePolicy[] = ["WORKSPACE_MEMBERS", "ADMINS", "OWNER"];

function instructionsValue(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > MAX_INSTRUCTIONS_LENGTH) throw new Error(`Instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters`);
  return value.trim() || null;
}
function invokePolicyValue(value: unknown): AgentInvokePolicy | null {
  if (value === undefined || value === null) return null;
  if (!INVOKE_POLICIES.includes(value as AgentInvokePolicy)) throw new Error("Invalid invoke policy");
  return value as AgentInvokePolicy;
}
function isMissingColumn(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "P2022" || error.code === "P2021");
}

/** The workspace for these slugs, only if the caller is a member of it. A non-member learns nothing about it. */
async function memberWorkspace(orgSlug: string, workspaceSlug: string) {
  const { prisma, userId } = await account();
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId } } }, select: { id: true } });
  if (!workspace) throw new Error("Workspace not found");
  return { prisma, userId, workspaceId: workspace.id };
}

export async function createCloudAgent(input: {
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  description?: string;
  instructions?: string;
  model?: string | null;
  ownerType: "USER" | "WORKSPACE";
  /** Shared agents only; a personal agent is always invoked by its owner alone. */
  invokePolicy?: AgentInvokePolicy;
  /** Access to enable in this workspace when the creator administers it. Defaults to read only. */
  access?: "READ" | "WRITE";
}) {
  requireEnabled();
  if (input.ownerType !== "USER" && input.ownerType !== "WORKSPACE") throw new Error("Invalid owner type");
  const access = input.access ?? "READ";
  if (access !== "READ" && access !== "WRITE") throw new Error("Invalid access");
  // Shared agents are an administrator action: resolveWorkspaceAdmin refuses anyone else before any input is read.
  const admin = input.ownerType === "WORKSPACE" ? await resolveWorkspaceAdmin(input.orgSlug, input.workspaceSlug) : null;
  const { prisma, userId, workspaceId } = admin ? { ...admin, userId: (await account()).userId } : await memberWorkspace(input.orgSlug, input.workspaceSlug);
  const data = {
    name: nameValue(input.name),
    description: descriptionValue(input.description),
    instructions: instructionsValue(input.instructions),
    model: parseAgentModel(input.model),
    kind: "CLOUD",
    status: "ACTIVE",
    ownerType: input.ownerType,
    ownerUserId: input.ownerType === "USER" ? userId : null,
    ownerWorkspaceId: input.ownerType === "WORKSPACE" ? workspaceId : null,
    invokePolicy: input.ownerType === "WORKSPACE" ? (invokePolicyValue(input.invokePolicy) ?? "WORKSPACE_MEMBERS") : "OWNER",
    updatedAt: new Date(),
  };
  // A shared agent has no reach until a human administrator enables it, and the creator IS that administrator, so the
  // grant is recorded in the same step (grantedByUserId = the creator, who is re-verified on every use). A personal agent
  // is enabled automatically only when its creator also administers the workspace; otherwise an administrator does it from
  // Workspace > Agents, exactly as for any other personal agent.
  const grantNow = input.ownerType === "WORKSPACE" || (await isWorkspaceAdminUser(prisma, userId, workspaceId));
  try {
    const agent = await prisma.$transaction(async (tx) => {
      const created = await tx.agent.create({ data, select: AGENT_LEGACY_SELECT });
      if (grantNow) await tx.agentWorkspaceGrant.create({ data: { agentId: created.id, workspaceId, access, grantedByUserId: userId, updatedAt: new Date() }, select: { id: true } });
      return created;
    });
    revalidatePath(`/${input.orgSlug}/${input.workspaceSlug}/settings`);
    revalidatePath("/settings/agents");
    return { id: agent.id, enabledInWorkspace: grantNow };
  } catch (error) {
    if (isMissingColumn(error)) throw new Error("Cloud agents are not available yet. Try again after the database update finishes.");
    throw error;
  }
}

export async function updateCloudAgent(id: string, input: { name?: string; description?: string; instructions?: string; model?: string | null; invokePolicy?: AgentInvokePolicy }) {
  const { prisma, userId } = await account();
  requireEnabled();
  const agent = await findAgentById(prisma, id);
  // Same answer for "missing", "not yours" and "not a cloud agent": an id reveals nothing about an agent you cannot manage.
  if (!agent || agentKind(agent) !== "CLOUD" || !(await canManageAgent(prisma, { userId }, agent))) throw new Error("Agent not found");
  const owner = agentOwner(agent);
  const data: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) data.name = nameValue(input.name);
  if (input.description !== undefined) data.description = descriptionValue(input.description);
  if (input.instructions !== undefined) data.instructions = instructionsValue(input.instructions);
  // A model saved before the allowed set changed stays valid as long as it is left alone.
  if (input.model !== undefined && (input.model ?? null) !== (agent.model ?? null)) data.model = parseAgentModel(input.model);
  if (input.invokePolicy !== undefined) {
    // A personal agent is invoked by its owner alone (the intersection rule for others is an open ADR question), so there is nothing to choose.
    if (owner?.type !== "WORKSPACE") throw new Error("Only shared agents have an invoke policy");
    data.invokePolicy = invokePolicyValue(input.invokePolicy);
  }
  await prisma.agent.update({ where: { id }, data, select: { id: true } });
  revalidatePath("/settings/agents");
}

/** Workspace default: administrators only, and only a shared cloud agent that lives in this workspace and is enabled here. */
export async function setWorkspaceDefaultAgentAction(orgSlug: string, workspaceSlug: string, agentId: string | null) {
  const { userId } = await account();
  const { prisma, workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug);
  if (agentId === null) {
    await clearWorkspaceDefaultAgent(prisma, workspaceId);
  } else {
    requireEnabled();
    const agent = await findAgentById(prisma, agentId);
    const owner = agent ? agentOwner(agent) : null;
    if (!agent || agent.status !== "ACTIVE" || agentKind(agent) !== "CLOUD" || owner?.type !== "WORKSPACE" || owner.workspaceId !== workspaceId) throw new Error("Choose an active shared cloud agent of this workspace");
    if (!(await liveGrantedWorkspaceIds(agent, "READ")).includes(workspaceId)) throw new Error("Enable this agent in the workspace before making it the default");
    await setWorkspaceDefaultAgent(prisma, { workspaceId, agentId, setByUserId: userId });
  }
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
}

/** Personal default: any member, for themselves only. The agent must be one this member could run right now. */
export async function setMyDefaultAgentAction(orgSlug: string, workspaceSlug: string, agentId: string | null) {
  const { prisma, userId, workspaceId } = await memberWorkspace(orgSlug, workspaceSlug);
  if (agentId === null) {
    await clearUserDefaultAgent(prisma, { userId, workspaceId });
  } else {
    requireEnabled();
    try {
      // The same checks a run goes through (cloud, active, granted here, invokable by this member), so a default can never
      // name an agent the member could not pick directly.
      const runnable = await resolveRunAgent(prisma, { userId, workspaceId, requestedAgentId: agentId });
      if (!runnable) throw new Error("Agent not found");
    } catch (error) {
      if (error instanceof AgentSelectionError) throw new Error(error.message);
      throw error;
    }
    await setUserDefaultAgent(prisma, { userId, workspaceId, agentId });
  }
  revalidatePath(`/${orgSlug}/${workspaceSlug}/settings`);
  revalidatePath("/settings/agents");
}

export async function createAgentKey(agentId: string, input: { name: string; expiresAt?: string }) {
  const { prisma, userId } = await account();
  requireEnabled();
  const agent = await findAgentById(prisma, agentId);
  // A personal key is bound to its holder, so only a USER-owned agent can have one.
  if (!agent || !isUserOwnedBy(agent, userId)) throw new Error("Agent not found");
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
  const agent = await findAgentById(prisma, agentId);
  if (!agent || agent.status !== "ACTIVE") throw new Error("Agent not found");
  const owner = agentOwner(agent);
  if (!owner) throw new Error("Agent not found");
  // A shared agent is granted only into the workspace that owns it: another workspace's admin
  // must not be able to pull it into theirs.
  if (owner.type === "WORKSPACE" && owner.workspaceId !== workspaceId) throw new Error("Agent not found");
  await prisma.$transaction(async (tx) => {
    // A WORKSPACE-owned agent has no owner user, so there is no membership to require or lock.
    const member = owner.type === "USER" ? await tx.workspaceMember.findFirst({ where: { workspaceId, userId: owner.userId }, select: { id: true, role: true } }) : null;
    if (owner.type === "USER" && !member) throw new Error("Agent owner must be a current workspace member");
    // Touch the membership row so DSQL rejects a concurrent membership delete.
    // Without this write, a grant could commit after removal and revive on rejoin.
    // Compare the role as well: a concurrent demotion must never be overwritten
    // by the role read before waiting for PostgreSQL's row lock.
    if (member) {
      const locked = await tx.workspaceMember.updateMany({ where: { id: member.id, role: member.role }, data: { role: member.role } });
      if (locked.count !== 1) throw new Error("Membership changed; retry the operation");
    }
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
