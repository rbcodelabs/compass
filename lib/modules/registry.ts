/**
 * The workspace module registry: the code-side list of product capabilities a workspace administrator can switch on or off
 * (Settings > Modules). Pure data and pure functions, safe to import from client and server code alike.
 *
 * Storage is one row per (workspace, key) in `workspace_modules`; no row means the `defaultEnabled` below. Adding a module is
 * therefore an entry here and nothing else: no migration. See docs/adr-workspace-modules.md.
 *
 * What is NOT a module: infrastructure, secrets and migration-mirror flags (COMPASS_ENTITY_LINKS_*, blob tokens, analytics keys)
 * stay environment configuration, and COMPASS_PASSKEYS_ENABLED stays an environment flag because passkeys are a user/auth-level
 * capability with no workspace to scope them to.
 */

export const MODULE_KEYS = [
  "research_capture",
  "pm_interview",
  "research_voice_authoritative",
  "research_voice_browser",
  "research_voice_discovery",
  "workspace_updates",
  "following",
  "agents",
  "launch_workflow",
] as const

export type ModuleKey = (typeof MODULE_KEYS)[number]

export interface ModuleDefinition {
  key: ModuleKey
  label: string
  description: string
  /** What a workspace with no stored row gets. Everything is off by default: a module is an explicit opt-in. */
  defaultEnabled: boolean
  /** Modules that must be effectively enabled for this one to be. Enforced on read (fail closed) and on toggle. */
  requires: readonly ModuleKey[]
  /** Settings grouping only. */
  group: "Research" | "Collaboration" | "Agents" | "Delivery"
  /** Voice modules guard security-sensitive paths; the Settings page says so. */
  sensitive?: boolean
}

export const MODULE_REGISTRY: Readonly<Record<ModuleKey, ModuleDefinition>> = {
  research_capture: {
    key: "research_capture",
    label: "Research capture",
    description: "Customer interviews, usability tests and external studies: the Research area, participant links and research MCP tools.",
    defaultEnabled: false,
    requires: [],
    group: "Research",
  },
  pm_interview: {
    key: "pm_interview",
    label: "PM interviews",
    description: "Guided PM interviews that flesh out an opportunity, solution or experiment (Refine with a PM interview).",
    defaultEnabled: false,
    requires: [],
    group: "Research",
  },
  research_voice_authoritative: {
    key: "research_voice_authoritative",
    label: "Research voice: authoritative transport",
    description: "Server-verified realtime voice events for research sessions. Reserved for the authoritative transport; guards a security-sensitive path.",
    defaultEnabled: false,
    requires: ["research_capture"],
    group: "Research",
    sensitive: true,
  },
  research_voice_browser: {
    key: "research_voice_browser",
    label: "Research voice: browser",
    description: "Participants can speak their answers in the browser. Transcripts are participant-submitted evidence, not authoritative voice events.",
    defaultEnabled: false,
    requires: ["research_capture"],
    group: "Research",
    sensitive: true,
  },
  research_voice_discovery: {
    key: "research_voice_discovery",
    label: "Research voice: customer discovery",
    description: "Voice for customer-discovery interviews over the authoritative transport.",
    defaultEnabled: false,
    requires: ["research_voice_authoritative"],
    group: "Research",
    sensitive: true,
  },
  workspace_updates: {
    key: "workspace_updates",
    label: "Workspace updates",
    description: "Records changes and shows the Updates catch-up page. Captures new events only; there is no historical backfill.",
    defaultEnabled: false,
    requires: [],
    group: "Collaboration",
  },
  following: {
    key: "following",
    label: "Following and notifications",
    description: "Follow objects and receive in-app notifications; the notifications bell and inbox.",
    defaultEnabled: false,
    requires: [],
    group: "Collaboration",
  },
  agents: {
    key: "agents",
    label: "Agents",
    description: "Personal and shared agents can act in this workspace, be assigned tasks, and appear in the OAuth consent screen.",
    defaultEnabled: false,
    requires: [],
    group: "Agents",
  },
  launch_workflow: {
    key: "launch_workflow",
    label: "Marketing launch workflow",
    description: "Launch tiers, checklists, the Launching and Launched roadmap horizons and positioning briefs.",
    defaultEnabled: false,
    requires: [],
    group: "Delivery",
  },
}

/** The actionable sentence every disabled-module error uses. */
export function moduleDisabledMessage(key: ModuleKey): string {
  return `${MODULE_REGISTRY[key].label} is not enabled for this workspace. A workspace admin can enable it in Settings > Modules.`
}

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === "string" && (MODULE_KEYS as readonly string[]).includes(value)
}

/** Modules that list `key` in `requires`, directly. */
export function directDependents(key: ModuleKey): ModuleKey[] {
  return MODULE_KEYS.filter((candidate) => MODULE_REGISTRY[candidate].requires.includes(key))
}

/** Every module that transitively depends on `key`, nearest first, without duplicates. */
export function allDependents(key: ModuleKey): ModuleKey[] {
  const seen = new Set<ModuleKey>()
  const queue = [key]
  while (queue.length) {
    for (const next of directDependents(queue.shift() as ModuleKey)) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return [...seen]
}

/** Every module `key` transitively requires, without duplicates. */
export function allRequirements(key: ModuleKey): ModuleKey[] {
  const seen = new Set<ModuleKey>()
  const queue = [...MODULE_REGISTRY[key].requires]
  while (queue.length) {
    const next = queue.shift() as ModuleKey
    if (seen.has(next)) continue
    seen.add(next)
    queue.push(...MODULE_REGISTRY[next].requires)
  }
  return [...seen]
}

export type StoredModuleStates = ReadonlyMap<string, boolean>

export interface ResolvedModule {
  key: ModuleKey
  /** What the workspace actually gets: stored (or default) AND every requirement effectively enabled. */
  enabled: boolean
  /** The stored/default value before dependencies are applied. */
  selected: boolean
  /** True when a stored row exists; false when `selected` is the registry default. */
  stored: boolean
  /** The requirements that are not effectively enabled (empty when none, or when `selected` is false). */
  blockedBy: ModuleKey[]
}

/**
 * Resolves every registered module from the stored rows. Unknown stored keys are ignored. Dependencies are applied transitively and
 * fail closed: a module whose requirement is off is off, whatever its own row says.
 */
export function resolveModules(stored: StoredModuleStates): Record<ModuleKey, ResolvedModule> {
  const resolved = {} as Record<ModuleKey, ResolvedModule>
  const visiting = new Set<ModuleKey>()
  const resolve = (key: ModuleKey): ResolvedModule => {
    const existing = resolved[key]
    if (existing) return existing
    // The registry is static and acyclic (asserted by a test); a cycle would fail closed rather than recurse forever.
    if (visiting.has(key)) return { key, enabled: false, selected: false, stored: false, blockedBy: [] }
    visiting.add(key)
    const definition = MODULE_REGISTRY[key]
    const hasRow = stored.has(key)
    const selected = hasRow ? stored.get(key) === true : definition.defaultEnabled
    const blockedBy = selected ? definition.requires.filter((requirement) => !resolve(requirement).enabled) : []
    visiting.delete(key)
    return (resolved[key] = { key, enabled: selected && blockedBy.length === 0, selected, stored: hasRow, blockedBy })
  }
  for (const key of MODULE_KEYS) resolve(key)
  return resolved
}

export class ModuleToggleError extends Error {
  constructor(message: string, readonly code: "UNKNOWN_MODULE" | "REQUIREMENT_DISABLED") {
    super(message)
    this.name = "ModuleToggleError"
  }
}

/**
 * The writes a toggle implies, given the current stored rows.
 *  - Enabling requires every requirement to be effectively enabled already; otherwise it is refused naming them (never silently
 *    enabling extra, possibly sensitive, modules).
 *  - Disabling also switches off every module that depends on it, so the stored state never says "on" for something that cannot
 *    run. (Reads are fail-closed regardless.)
 * Returns only rows whose value changes.
 */
export function planModuleToggle(stored: StoredModuleStates, key: string, enabled: boolean): { key: ModuleKey; enabled: boolean }[] {
  if (!isModuleKey(key)) throw new ModuleToggleError(`Unknown module: ${key}`, "UNKNOWN_MODULE")
  const current = resolveModules(stored)
  if (enabled) {
    const missing = MODULE_REGISTRY[key].requires.filter((requirement) => !current[requirement].enabled)
    if (missing.length) {
      throw new ModuleToggleError(
        `${MODULE_REGISTRY[key].label} requires ${missing.map((requirement) => MODULE_REGISTRY[requirement].label).join(", ")} to be enabled first.`,
        "REQUIREMENT_DISABLED",
      )
    }
    return current[key].stored && current[key].selected ? [] : [{ key, enabled: true }]
  }
  const writes: { key: ModuleKey; enabled: boolean }[] = []
  for (const target of [key, ...allDependents(key)]) {
    if (current[target].selected) writes.push({ key: target, enabled: false })
  }
  return writes
}
