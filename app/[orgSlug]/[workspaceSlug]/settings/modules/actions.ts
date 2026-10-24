"use server"

/**
 * Settings > Modules: switch a workspace module on or off (docs/adr-workspace-modules.md).
 *
 * ## Why workspace admin
 *
 * A module changes what every member and every agent of the workspace can do, and some of them (the voice modules) guard
 * security-sensitive paths. It therefore uses resolveWorkspaceAdmin, which admits workspace ADMINs and org admins who are also
 * workspace members, and deliberately NOT the membership-only pattern of the neighbouring toggles in settings/actions.ts. The old
 * launch workflow toggle used that membership-only check; it is this action now.
 *
 * ## What it trusts
 *
 * Only the two slugs (turned into a workspace id the caller is authorized for), a module key checked against the registry, and a
 * boolean. Expected failures (not an admin, an unknown key, a missing requirement) are returned as values, because Next strips the
 * message of an error thrown from a server action in production.
 */

import { revalidatePath } from "next/cache"
import { auth } from "@/auth"
import { isPermissionError, resolveWorkspaceAdmin } from "@/lib/permissions"
import { ModuleToggleError } from "@/lib/modules/registry"
import { describeModules, setWorkspaceModule, type ModuleChange, type ModuleView } from "@/lib/modules/server"

export type SetWorkspaceModuleResult =
  | { ok: true; changes: ModuleChange[]; modules: ModuleView[] }
  | { ok: false; error: string }

export async function setWorkspaceModuleEnabled(
  orgSlug: string,
  workspaceSlug: string,
  key: string,
  enabled: boolean,
): Promise<SetWorkspaceModuleResult> {
  try {
    if (typeof enabled !== "boolean") return { ok: false, error: "Choose on or off." }
    const { workspaceId } = await resolveWorkspaceAdmin(orgSlug, workspaceSlug)
    const session = await auth()
    const changes = await setWorkspaceModule({ workspaceId, key, enabled, userId: session?.user?.id ?? null })
    // The layout renders the nav from the modules, and several modules change what pages show.
    revalidatePath(`/${orgSlug}/${workspaceSlug}`, "layout")
    return { ok: true, changes, modules: await describeModules(workspaceId, { fresh: true }) }
  } catch (error) {
    if (isPermissionError(error) || error instanceof ModuleToggleError) return { ok: false, error: error.message }
    throw error
  }
}
