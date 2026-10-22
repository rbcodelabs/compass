/**
 * Default agent selection (ADR "Cloud agents as first-class identities", phase 3).
 *
 * Two small tables (migration 101) say which agent a run uses when nobody picked one:
 *   - `user_default_agents`      a member's personal override, per workspace
 *   - `workspace_default_agents` the workspace's default, set by an administrator
 * The order is: explicit pick > user default > workspace default > the built-in "Compass Agent".
 *
 * This module only stores and reads the ids. It does NOT decide that a default is still usable: the agent may
 * have been suspended, lost its grant, or the user may no longer be allowed to invoke it. That check lives with
 * the explicit-pick check in `resolveRunAgent` (lib/agent-run-identity.ts) so both paths run the same predicates,
 * and a stale default silently falls through there instead of failing a chat.
 *
 * Tolerates migration 101 being unapplied: reads answer "no default"; writes refuse with a clear message. Only a
 * missing table (P2021) or a missing column on one (P2022, e.g. a partially applied or older shape) means "not yet" -- anything else
 * is a real fault and is rethrown.
 */

import type { AppPrismaClient } from "@/lib/db"

/** Sent as `agentId` by a picker to run the built-in agent on purpose, bypassing any default. */
export const BUILT_IN_AGENT_SELECTION = "builtin"

type DefaultsDb = Pick<AppPrismaClient, "workspaceDefaultAgent" | "userDefaultAgent">

export class AgentDefaultsUnavailableError extends Error {
  constructor() {
    super("Default agents are not available yet. Try again after the database update finishes.")
    this.name = "AgentDefaultsUnavailableError"
  }
}

const NEGATIVE_TTL_MS = 30_000
let availability: { value: boolean; checkedAt: number } | null = null

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "P2021" || error.code === "P2022")
}

/** Test seam: forget the probe result so a suite can exercise both branches. */
export function resetAgentDefaultsAvailabilityCache() {
  availability = null
}

/** A positive result is permanent; a negative one is re-probed, so applying the migration needs no redeploy. */
export async function agentDefaultsAvailable(prisma: DefaultsDb): Promise<boolean> {
  if (availability?.value) return true
  if (availability && Date.now() - availability.checkedAt < NEGATIVE_TTL_MS) return false
  try {
    await Promise.all([prisma.workspaceDefaultAgent.findFirst({ select: { id: true } }), prisma.userDefaultAgent.findFirst({ select: { id: true } })])
    availability = { value: true, checkedAt: Date.now() }
    return true
  } catch (error) {
    if (!isMissingTable(error)) throw error
    availability = { value: false, checkedAt: Date.now() }
    return false
  }
}

/** Runs a read; a missing table answers `fallback` (and is remembered), anything else is rethrown. */
async function readOrFallback<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  if (availability && !availability.value && Date.now() - availability.checkedAt < NEGATIVE_TTL_MS) return fallback
  try {
    return await read()
  } catch (error) {
    if (!isMissingTable(error)) throw error
    availability = { value: false, checkedAt: Date.now() }
    return fallback
  }
}

export async function getWorkspaceDefaultAgentId(prisma: DefaultsDb, workspaceId: string): Promise<string | null> {
  return readOrFallback(async () => (await prisma.workspaceDefaultAgent.findFirst({ where: { workspaceId }, select: { agentId: true } }))?.agentId ?? null, null)
}

export async function getUserDefaultAgentId(prisma: DefaultsDb, userId: string, workspaceId: string): Promise<string | null> {
  return readOrFallback(async () => (await prisma.userDefaultAgent.findFirst({ where: { userId, workspaceId }, select: { agentId: true } }))?.agentId ?? null, null)
}

/**
 * The stored default ids for one user in one workspace, in resolution order (personal first). Either may be null.
 * Usability is NOT checked here; see the module comment.
 */
export async function getStoredDefaultAgentIds(prisma: DefaultsDb, input: { userId: string; workspaceId: string }): Promise<{ userDefaultAgentId: string | null; workspaceDefaultAgentId: string | null }> {
  const [userDefaultAgentId, workspaceDefaultAgentId] = await Promise.all([
    getUserDefaultAgentId(prisma, input.userId, input.workspaceId),
    getWorkspaceDefaultAgentId(prisma, input.workspaceId),
  ])
  return { userDefaultAgentId, workspaceDefaultAgentId }
}

/** Runs a write; a missing table becomes a clear, user-facing error. */
async function writeOrUnavailable<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (isMissingTable(error)) {
      availability = { value: false, checkedAt: Date.now() }
      throw new AgentDefaultsUnavailableError()
    }
    throw error
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
}

/**
 * Find-then-write rather than ON CONFLICT (unproven against DSQL's async unique index). A concurrent first write loses to
 * the unique index (P2002) and is retried once as an update, so two admins clicking at once still end with one row.
 */
async function upsertByFind<T extends { id: string }>(find: () => Promise<T | null>, update: (id: string) => Promise<unknown>, create: () => Promise<unknown>) {
  const existing = await find()
  if (existing) return update(existing.id)
  try {
    return await create()
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    const raced = await find()
    if (!raced) throw error
    return update(raced.id)
  }
}

export async function setWorkspaceDefaultAgent(prisma: DefaultsDb, input: { workspaceId: string; agentId: string; setByUserId: string }): Promise<void> {
  const now = new Date()
  await writeOrUnavailable(() =>
    upsertByFind(
      () => prisma.workspaceDefaultAgent.findFirst({ where: { workspaceId: input.workspaceId }, select: { id: true } }),
      (id) => prisma.workspaceDefaultAgent.update({ where: { id }, data: { agentId: input.agentId, setByUserId: input.setByUserId, updatedAt: now }, select: { id: true } }),
      () => prisma.workspaceDefaultAgent.create({ data: { workspaceId: input.workspaceId, agentId: input.agentId, setByUserId: input.setByUserId, updatedAt: now }, select: { id: true } }),
    ),
  )
}

export async function clearWorkspaceDefaultAgent(prisma: DefaultsDb, workspaceId: string): Promise<void> {
  await writeOrUnavailable(() => prisma.workspaceDefaultAgent.deleteMany({ where: { workspaceId } }))
}

export async function setUserDefaultAgent(prisma: DefaultsDb, input: { userId: string; workspaceId: string; agentId: string }): Promise<void> {
  const now = new Date()
  await writeOrUnavailable(() =>
    upsertByFind(
      () => prisma.userDefaultAgent.findFirst({ where: { userId: input.userId, workspaceId: input.workspaceId }, select: { id: true } }),
      (id) => prisma.userDefaultAgent.update({ where: { id }, data: { agentId: input.agentId, updatedAt: now }, select: { id: true } }),
      () => prisma.userDefaultAgent.create({ data: { userId: input.userId, workspaceId: input.workspaceId, agentId: input.agentId, updatedAt: now }, select: { id: true } }),
    ),
  )
}

export async function clearUserDefaultAgent(prisma: DefaultsDb, input: { userId: string; workspaceId: string }): Promise<void> {
  await writeOrUnavailable(() => prisma.userDefaultAgent.deleteMany({ where: { userId: input.userId, workspaceId: input.workspaceId } }))
}
