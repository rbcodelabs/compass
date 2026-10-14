/**
 * Who may CHANGE a workspace's thinking model: the same rule resolveWorkspaceAdmin (lib/permissions.ts) applies to
 * updateThinkingModel. The caller must hold a real workspace membership, and then be a workspace ADMIN or an
 * organization owner/admin. An org admin who reaches Settings only through the read-only fallback has no membership, so
 * the form is not offered to them (its Save would fail with "Workspace not found").
 *
 * Presentation gate only; the server action enforces the rule again.
 */
import { isOrgAdminRole, normalizeWorkspaceRole } from "@/lib/roles"

export function canChangeThinkingModel(input: { workspaceRole: string | null | undefined; orgRole: string | null | undefined }): boolean {
  if (input.workspaceRole === null || input.workspaceRole === undefined) return false // no workspace membership
  return normalizeWorkspaceRole(input.workspaceRole) === "ADMIN" || isOrgAdminRole(input.orgRole)
}
