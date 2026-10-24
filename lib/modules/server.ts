import { cache } from "react"
import getPrisma from "@/lib/db"
import {
  MODULE_KEYS,
  MODULE_REGISTRY,
  moduleDisabledMessage,
  planModuleToggle,
  resolveModules,
  type ModuleKey,
  type ResolvedModule,
} from "@/lib/modules/registry"

/**
 * Server-side access to workspace modules (see lib/modules/registry.ts and docs/adr-workspace-modules.md).
 *
 * Everything that used to read a product-feature environment flag asks `isModuleEnabled(workspaceId, key)` or calls
 * `requireModule(workspaceId, key)` instead. The answer is read from `workspace_modules` once per request (React `cache`; outside a
 * React render the cache is a pass-through, so a long-lived process never serves a stale answer).
 *
 * Fail closed: an unreadable table never turns a module ON. The one tolerated failure is a missing table (Prisma P2021, migration 105
 * not applied yet): every module then reads as its stored-less default (off), except the launch workflow, which falls back to the legacy
 * `workspaces.launch_workflow_enabled` column so the launch surface keeps working through the deploy-then-migrate gap. Any other
 * database error propagates; callers on a security path must not catch it into "enabled".
 */

export { moduleDisabledMessage }

export class ModuleDisabledError extends Error {
  readonly code = "MODULE_DISABLED"
  constructor(readonly moduleKey: ModuleKey, message = moduleDisabledMessage(moduleKey)) {
    super(message)
    this.name = "ModuleDisabledError"
  }
}

function isMissingTable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2021"
}

/** The raw rows for a workspace (key -> enabled), or the legacy fallback when the table does not exist yet. */
async function loadStoredStates(workspaceId: string): Promise<Map<string, boolean>> {
  const prisma = getPrisma()
  try {
    const rows = await prisma.workspaceModule.findMany({ where: { workspaceId }, select: { moduleKey: true, enabled: true } })
    return new Map(rows.map((row) => [row.moduleKey, row.enabled]))
  } catch (error) {
    if (!isMissingTable(error)) throw error
    const legacy = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { launchWorkflowEnabled: true } })
    return new Map(legacy?.launchWorkflowEnabled ? [["launch_workflow", true]] : [])
  }
}

const loadResolved = cache(async (workspaceId: string): Promise<Record<ModuleKey, ResolvedModule>> => resolveModules(await loadStoredStates(workspaceId)))

/** Every registered module resolved for the workspace (stored value or default, with dependencies applied). */
export async function getWorkspaceModuleStates(workspaceId: string): Promise<Record<ModuleKey, ResolvedModule>> {
  return loadResolved(workspaceId)
}

export async function isModuleEnabled(workspaceId: string, key: ModuleKey): Promise<boolean> {
  return (await loadResolved(workspaceId))[key].enabled
}

/** Throws ModuleDisabledError unless the module is effectively enabled for the workspace. */
export async function requireModule(workspaceId: string, key: ModuleKey, message?: string): Promise<void> {
  if (!(await isModuleEnabled(workspaceId, key))) throw new ModuleDisabledError(key, message)
}

/** The keys of every effectively enabled module, in registry order. Handed to client navigation by the workspace layout. */
export async function enabledModuleKeys(workspaceId: string): Promise<ModuleKey[]> {
  const states = await loadResolved(workspaceId)
  return MODULE_KEYS.filter((key) => states[key].enabled)
}

/** The workspace-scoped booleans navigation needs for the module-gated entries it can show without table checks. */
export async function researchNavEnabled(workspaceId: string): Promise<boolean> {
  return isModuleEnabled(workspaceId, "research_capture")
}

export interface ModuleChange { key: ModuleKey; enabled: boolean }

/**
 * Persists a toggle (find-then-write; the unique index is the backstop, no ON CONFLICT is relied on). Enabling is refused when a
 * requirement is off; disabling cascades to dependents (see planModuleToggle). The caller is responsible for the admin check.
 * The launch workflow is also mirrored into the legacy column so a rollback to code that still reads it sees the same answer.
 */
export async function setWorkspaceModule(input: { workspaceId: string; key: string; enabled: boolean; userId: string | null }): Promise<ModuleChange[]> {
  const prisma = getPrisma()
  const rows = await prisma.workspaceModule.findMany({ where: { workspaceId: input.workspaceId }, select: { id: true, moduleKey: true, enabled: true } })
  const stored = new Map(rows.map((row) => [row.moduleKey, row.enabled]))
  const writes = planModuleToggle(stored, input.key, input.enabled)
  const now = new Date()
  for (const write of writes) {
    const existing = rows.find((row) => row.moduleKey === write.key)
    if (existing) {
      await prisma.workspaceModule.update({ where: { id: existing.id }, data: { enabled: write.enabled, updatedByUserId: input.userId, updatedAt: now } })
    } else {
      await prisma.workspaceModule.create({ data: { workspaceId: input.workspaceId, moduleKey: write.key, enabled: write.enabled, updatedByUserId: input.userId, createdAt: now, updatedAt: now } })
    }
  }
  if (writes.some((write) => write.key === "launch_workflow")) {
    const launch = writes.find((write) => write.key === "launch_workflow")
    await prisma.workspace.update({ where: { id: input.workspaceId }, data: { launchWorkflowEnabled: launch?.enabled === true }, select: { id: true } })
  }
  return writes
}

/** A module as the Settings page and the MCP/REST tools present it: everything needed to explain why it is on or off. */
export interface ModuleView {
  key: ModuleKey
  label: string
  description: string
  group: string
  sensitive: boolean
  /** Effective: what the workspace actually gets. */
  enabled: boolean
  /** The administrator's choice (or the registry default) before dependencies are applied. */
  selected: boolean
  /** False when `selected` is just the registry default because no choice was ever saved. */
  explicit: boolean
  defaultEnabled: boolean
  requires: { key: ModuleKey; label: string; enabled: boolean }[]
  /** Why a selected module is still off: the requirements that are not enabled. */
  blockedBy: ModuleKey[]
}

/** `fresh` skips the per-request cache; use it right after a write in the same request (the cache would still hold the old answer). */
export async function describeModules(workspaceId: string, options: { fresh?: boolean } = {}): Promise<ModuleView[]> {
  const states = options.fresh ? resolveModules(await loadStoredStates(workspaceId)) : await loadResolved(workspaceId)
  return MODULE_KEYS.map((key) => {
    const definition = MODULE_REGISTRY[key]
    const state = states[key]
    return {
      key,
      label: definition.label,
      description: definition.description,
      group: definition.group,
      sensitive: definition.sensitive === true,
      enabled: state.enabled,
      selected: state.selected,
      explicit: state.stored,
      defaultEnabled: definition.defaultEnabled,
      requires: definition.requires.map((requirement) => ({ key: requirement, label: MODULE_REGISTRY[requirement].label, enabled: states[requirement].enabled })),
      blockedBy: state.blockedBy,
    }
  })
}
