/**
 * Which sandbox snapshot an agent run boots from (migration 110).
 *
 * STANDARD is the golden snapshot every run used before. DEVELOPER is the layered snapshot with Postgres, pnpm and a
 * toolchain (lib/agent-sandbox-developer.ts). An agent opts in with `agents.sandbox_class`, and its workspace must also
 * have `agent_developer_sandbox_enabled`; both are required so a workspace admin controls the larger, costlier sandbox.
 *
 * A DEVELOPER agent is REFUSED, never quietly run on the standard snapshot, when the class is off or the snapshot is not built:
 * its instructions assume Postgres, and a run that fails halfway through with "psql: command not found" is a worse answer
 * than an up-front one. Both columns are read tolerantly (they are deliberately not in the shared agent select), so a
 * deployment where migration 110 is not applied yet keeps running everything as STANDARD.
 */

import type { AppPrismaClient } from "@/lib/db"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { getRuntimeSnapshot, type SandboxClass } from "@/lib/agent-runtime-snapshots"

export function parseSandboxClass(value: unknown): SandboxClass {
  return value === "DEVELOPER" ? "DEVELOPER" : "STANDARD"
}

/** An agent's configured class. Missing column, missing agent, or an unknown value all read as STANDARD. */
export async function readAgentSandboxClass(prisma: AppPrismaClient, agentId: string): Promise<SandboxClass> {
  try {
    const row = await prisma.agent.findUnique({ where: { id: agentId }, select: { sandboxClass: true } })
    return parseSandboxClass(row?.sandboxClass)
  } catch (error) {
    console.error("[agent-sandbox-class] could not read agent sandbox class", error instanceof Error ? error.message : "unknown error")
    return "STANDARD"
  }
}

/** Whether the workspace admin has allowed the DEVELOPER class. Missing column reads as off. */
export async function readWorkspaceDeveloperSandboxEnabled(prisma: AppPrismaClient, workspaceId: string): Promise<boolean> {
  try {
    const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { agentDeveloperSandboxEnabled: true } })
    return row?.agentDeveloperSandboxEnabled === true
  } catch (error) {
    console.error("[agent-sandbox-class] could not read workspace developer sandbox flag", error instanceof Error ? error.message : "unknown error")
    return false
  }
}

export type RunSnapshotResolution =
  | { ok: true; snapshotId: string; sandboxClass: SandboxClass }
  | { ok: false; code: "DEVELOPER_SANDBOX_DISABLED" | "DEVELOPER_SNAPSHOT_MISSING" | "STANDARD_SNAPSHOT_MISSING"; message: string }

type Deps = {
  getStandardSnapshotId: () => Promise<string | null>
  getDeveloperSnapshotId: () => Promise<string | null>
}

const defaultDeps: Deps = {
  getStandardSnapshotId: getGoldenSnapshotId,
  getDeveloperSnapshotId: async () => (await getRuntimeSnapshot("DEVELOPER"))?.snapshotId ?? null,
}

/**
 * The snapshot a run for `agent` (or the built-in agent, when null) in `workspaceId` should boot from.
 * Throws only if the golden-snapshot lookup itself throws, as the callers' existing lookup did.
 */
export async function resolveRunSnapshot(
  prisma: AppPrismaClient,
  input: { workspaceId: string; agentId: string | null },
  deps: Deps = defaultDeps,
): Promise<RunSnapshotResolution> {
  const sandboxClass = input.agentId ? await readAgentSandboxClass(prisma, input.agentId) : "STANDARD"
  if (sandboxClass === "DEVELOPER") {
    if (!(await readWorkspaceDeveloperSandboxEnabled(prisma, input.workspaceId))) {
      return { ok: false, code: "DEVELOPER_SANDBOX_DISABLED", message: "This agent needs the developer sandbox, which is not enabled for this workspace. A workspace admin can enable it in workspace settings." }
    }
    const snapshotId = await deps.getDeveloperSnapshotId()
    if (!snapshotId) {
      return { ok: false, code: "DEVELOPER_SNAPSHOT_MISSING", message: "The developer sandbox has not been built on this deployment yet. Run POST /api/admin/rebuild-agent-snapshot?class=developer." }
    }
    return { ok: true, snapshotId, sandboxClass }
  }
  const snapshotId = await deps.getStandardSnapshotId()
  if (!snapshotId) return { ok: false, code: "STANDARD_SNAPSHOT_MISSING", message: "Agent runtime is not initialized (no golden snapshot). Run POST /api/admin/rebuild-agent-snapshot." }
  return { ok: true, snapshotId, sandboxClass }
}

/** Configured classes for a set of agents, for the settings screen. Empty (everything STANDARD) when migration 110 is not applied. */
export async function loadAgentSandboxClasses(prisma: AppPrismaClient, agentIds: string[]): Promise<Map<string, SandboxClass>> {
  if (!agentIds.length) return new Map()
  try {
    const rows = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, sandboxClass: true } })
    return new Map(rows.map((row) => [row.id, parseSandboxClass(row.sandboxClass)]))
  } catch (error) {
    console.error("[agent-sandbox-class] could not load agent sandbox classes", error instanceof Error ? error.message : "unknown error")
    return new Map()
  }
}
