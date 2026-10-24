import { getMcpActor } from "@/lib/mcp-authz"
import { fail, ok } from "@/lib/mcp-output"
import { MODULE_REGISTRY, ModuleToggleError } from "@/lib/modules/registry"
import { describeModules, setWorkspaceModule, type ModuleView } from "@/lib/modules/server"

/**
 * MCP tools for workspace modules (docs/adr-workspace-modules.md).
 *
 *  - list_workspace_modules: every registered module with whether it is on, the administrator's choice, its requirements and what
 *    blocks it. It is what lets an agent that was refused ("Research capture is not enabled for this workspace...") see why and tell
 *    a person exactly what to switch on. Workspace members and delegated agents may read it.
 *  - update_workspace_module: switch one module. Workspace administrators only, and only a human identity: the gate
 *    (lib/mcp-tool-gates.ts) uses assertWorkspaceAdmin with no agent capability and the tool is DENY for agent identities, because
 *    some modules guard security-sensitive paths and an agent must never enable its own access. The handler repeats the check as
 *    a second line; the shared service key (trusted and global, which the gate skips) may update and is recorded with no user.
 */

const describeLine = (module: ModuleView) =>
  `${module.enabled ? "ON " : "OFF"} ${module.key} (${module.label})` +
  (module.selected && !module.enabled ? ` - selected but blocked: ${module.blockedBy.map((key) => MODULE_REGISTRY[key].label).join(", ")} must be on` : "") +
  (!module.explicit ? " [default]" : "")

export async function listWorkspaceModulesTool(input: { workspaceId: string }) {
  const modules = await describeModules(input.workspaceId)
  const on = modules.filter((module) => module.enabled).length
  return ok(
    `${on} of ${modules.length} modules enabled. A workspace admin can change them in Settings > Modules.\n${modules.map(describeLine).join("\n")}`,
    { items: modules, count: modules.length, enabledCount: on },
  )
}

export async function updateWorkspaceModuleTool(input: { workspaceId: string; moduleKey: string; enabled: boolean }) {
  const actor = getMcpActor()
  if (actor.purpose === "AGENT" || actor.purpose === "AGENT_TURN") return fail("Modules can only be changed by a human workspace administrator.")
  if (actor.purpose !== "SERVICE" && (!actor.userId || (actor.purpose && actor.purpose !== "USER"))) return fail("Modules can only be changed by a human workspace administrator.")
  try {
    const changes = await setWorkspaceModule({ workspaceId: input.workspaceId, key: input.moduleKey, enabled: input.enabled, userId: actor.userId ?? null })
    const modules = await describeModules(input.workspaceId, { fresh: true })
    const summary = changes.length === 0
      ? `No change: ${input.moduleKey} is already ${input.enabled ? "on" : "off"}.`
      : `Updated: ${changes.map((change) => `${change.key} ${change.enabled ? "on" : "off"}`).join(", ")}.`
    return ok(`**Module updated**\n${summary}\nID: ${input.workspaceId}`, { workspaceId: input.workspaceId, changes, items: modules, count: modules.length })
  } catch (error) {
    if (error instanceof ModuleToggleError) return fail(error.message, { code: error.code })
    throw error
  }
}
