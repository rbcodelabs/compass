/**
 * Role normalization.
 *
 * `OrganizationMember.role` and `WorkspaceMember.role` are both bare
 * `VarChar(50)` columns (prisma/schema.prisma:91, :154) — Aurora DSQL has no
 * enum support, so the database enforces nothing. Historically several writers
 * put values outside the TypeScript union into those columns:
 *
 *   - the MCP `create_workspace` handler copied the *org* role straight into
 *     `WorkspaceMember.role`, so an org OWNER got the workspace role "OWNER",
 *     which is not in `WorkspaceRole` ("ADMIN" | "MEMBER")
 *   - `app/api/admin/workspaces/route.ts` and `setup-compass-workspace.ts`
 *     inserted a lowercase 'owner'
 *
 * A `WorkspaceMember.role` of "OWNER" then failed the strict
 * `role !== "ADMIN"` gate in `resolveWorkspaceAdmin`, locking the workspace's
 * own creator out of admin-only actions (e.g. setting the scoring model).
 *
 * These helpers are the single place any raw role string from the database is
 * coerced back into its type's domain. They are deliberately permissive on
 * input (anything, including null) and total on output — an unrecognized value
 * degrades to the least-privileged role rather than throwing, so a bad row can
 * never crash a page render.
 */

import type { OrgRole, WorkspaceRole } from "@/lib/types"

/**
 * Coerces a raw `WorkspaceMember.role` string into a `WorkspaceRole`.
 *
 * "ADMIN" and "OWNER" (in any case, with surrounding whitespace) both map to
 * "ADMIN" — an org OWNER seeded into a workspace is an administrator of it.
 * Everything else, including null/undefined and unrecognized values, maps to
 * "MEMBER".
 */
export function normalizeWorkspaceRole(raw: string | null | undefined): WorkspaceRole {
  const value = raw?.trim().toUpperCase()
  return value === "ADMIN" || value === "OWNER" ? "ADMIN" : "MEMBER"
}

/**
 * Coerces a raw `OrganizationMember.role` string into an `OrgRole`.
 *
 * Unlike workspaces, organizations do have an OWNER role, so "OWNER" is
 * preserved. Everything unrecognized, including null/undefined, maps to
 * "MEMBER".
 */
export function normalizeOrgRole(raw: string | null | undefined): OrgRole {
  const value = raw?.trim().toUpperCase()
  if (value === "OWNER") return "OWNER"
  if (value === "ADMIN") return "ADMIN"
  return "MEMBER"
}

/**
 * Counts how many of the given raw stored roles are workspace administrators.
 *
 * Callers pass the raw strings straight from the database. Counting through
 * normalizeWorkspaceRole rather than filtering on an exact "ADMIN" match in SQL
 * is what makes the last-admin guards correct against legacy rows: a member
 * stored as "OWNER" or "owner" is a real administrator, and an exact match
 * would not count them, which would let the last true admin be demoted or
 * removed.
 */
export function countWorkspaceAdmins(roles: Array<string | null | undefined>): number {
  return roles.reduce((total, raw) => (normalizeWorkspaceRole(raw) === "ADMIN" ? total + 1 : total), 0)
}

/** True when an org role grants administrative rights (OWNER or ADMIN). */
export function isOrgAdminRole(raw: string | null | undefined): boolean {
  const role = normalizeOrgRole(raw)
  return role === "OWNER" || role === "ADMIN"
}

/** True when either membership grants human review authority. */
export function canDecideReview(workspaceRole: string | null | undefined, orgRole: string | null | undefined): boolean {
  return normalizeWorkspaceRole(workspaceRole) === "ADMIN" || isOrgAdminRole(orgRole)
}
