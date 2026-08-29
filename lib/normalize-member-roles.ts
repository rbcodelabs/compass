/**
 * The three repair passes that normalize member roles, extracted so both the
 * CLI script and the admin API route run exactly the same logic.
 *
 * Why both: OrganizationMember.role and WorkspaceMember.role are bare
 * VarChar(50) columns (Aurora DSQL has no enum support), and several writers
 * historically stored values outside their TypeScript union -- notably "OWNER"
 * as a workspace role, and a lowercase "owner". Locally the CLI can reach the
 * database directly; in preview and production it cannot, because Aurora DSQL
 * auth needs a Vercel OIDC token that only exists inside the Vercel runtime.
 * There the same work runs through app/api/admin/normalize-member-roles.
 *
 * This module deliberately does no logging. It returns a structured report and
 * lets each caller render it: the CLI prints it, the route serializes it.
 *
 * Note the usual DSQL rule that every update must set updatedAt explicitly does
 * not apply here -- neither organization_members nor workspace_members has an
 * updatedAt column, they only track createdAt.
 */

import type { PrismaClient } from "@prisma/client"
// Relative, with an explicit extension, so this module also resolves when the
// CLI script is executed directly by Node under --experimental-strip-types.
// The "@/" path alias is a bundler/TypeScript concept that Node cannot resolve.
import { normalizeOrgRole, normalizeWorkspaceRole } from "./roles.ts"

/** A single role rewrite, recorded whether or not it was actually written. */
export interface RoleChange {
  id: string
  email: string
  /** Workspace slug for pass 1, organization slug for pass 2. */
  scope: string
  from: string
  to: string
}

export interface PassReport {
  scanned: number
  changed: number
  skipped: number
  changes: RoleChange[]
}

/** Ordered so a renderer can reproduce per-organization output faithfully. */
export type OwnerBackfillEntry =
  | { kind: "promoted"; id: string; email: string; orgSlug: string; from: string; to: "OWNER" }
  | { kind: "skipped-empty"; orgSlug: string }

export interface OwnerBackfillReport {
  scanned: number
  promoted: number
  alreadyOwned: number
  emptySkipped: number
  entries: OwnerBackfillEntry[]
}

export interface NormalizeReport {
  dryRun: boolean
  workspaceMembers: PassReport
  organizationMembers: PassReport
  organizationOwners: OwnerBackfillReport
  totalChanged: number
  totalSkipped: number
}
/**
 * Runs all three passes.
 *
 * 1. WorkspaceMember.role  -> ADMIN | MEMBER
 * 2. OrganizationMember.role -> OWNER | ADMIN | MEMBER
 * 3. Any organization with no OWNER gets its earliest-created member promoted,
 *    preferring one who is already an admin.
 *
 * Idempotent: rows already holding a valid value are skipped without a write,
 * so a second run reports zero changes. With dryRun the same report is produced
 * and nothing is written.
 *
 * Pass 3 compares through normalizeOrgRole rather than an exact match so a dry
 * run, which has not applied pass 2 yet, reaches the same conclusion a live run
 * does.
 */
export async function normalizeMemberRoles(
  prisma: PrismaClient,
  options: { dryRun?: boolean } = {}
): Promise<NormalizeReport> {
  const dryRun = options.dryRun ?? false

  // ── Pass 1: WorkspaceMember.role ─────────────────────────────────────────
  const wsRows = await prisma.workspaceMember.findMany({
    select: {
      id: true,
      role: true,
      user: { select: { email: true } },
      workspace: { select: { slug: true } },
    },
    orderBy: { createdAt: "asc" },
  })

  const workspaceMembers: PassReport = {
    scanned: wsRows.length,
    changed: 0,
    skipped: 0,
    changes: [],
  }

  for (const row of wsRows) {
    const next = normalizeWorkspaceRole(row.role)
    if (row.role === next) {
      workspaceMembers.skipped++
      continue
    }
    if (!dryRun) {
      await prisma.workspaceMember.update({ where: { id: row.id }, data: { role: next } })
    }
    workspaceMembers.changes.push({
      id: row.id,
      email: row.user.email,
      scope: row.workspace.slug,
      from: row.role,
      to: next,
    })
    workspaceMembers.changed++
  }

  // ── Pass 2: OrganizationMember.role ──────────────────────────────────────
  const orgRows = await prisma.organizationMember.findMany({
    select: {
      id: true,
      role: true,
      user: { select: { email: true } },
      organization: { select: { slug: true } },
    },
    orderBy: { createdAt: "asc" },
  })

  const organizationMembers: PassReport = {
    scanned: orgRows.length,
    changed: 0,
    skipped: 0,
    changes: [],
  }

  for (const row of orgRows) {
    const next = normalizeOrgRole(row.role)
    if (row.role === next) {
      organizationMembers.skipped++
      continue
    }
    if (!dryRun) {
      await prisma.organizationMember.update({ where: { id: row.id }, data: { role: next } })
    }
    organizationMembers.changes.push({
      id: row.id,
      email: row.user.email,
      scope: row.organization.slug,
      from: row.role,
      to: next,
    })
    organizationMembers.changed++
  }
  // ── Pass 3: every organization needs an OWNER ────────────────────────────
  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      slug: true,
      members: {
        select: { id: true, role: true, user: { select: { email: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: { slug: "asc" },
  })

  const organizationOwners: OwnerBackfillReport = {
    scanned: orgs.length,
    promoted: 0,
    alreadyOwned: 0,
    emptySkipped: 0,
    entries: [],
  }

  for (const org of orgs) {
    if (org.members.some((m) => normalizeOrgRole(m.role) === "OWNER")) {
      organizationOwners.alreadyOwned++
      continue
    }
    if (org.members.length === 0) {
      organizationOwners.entries.push({ kind: "skipped-empty", orgSlug: org.slug })
      organizationOwners.emptySkipped++
      continue
    }
    // Earliest-created member, preferring one who is already an admin.
    const candidate =
      org.members.find((m) => normalizeOrgRole(m.role) === "ADMIN") ?? org.members[0]
    if (!dryRun) {
      await prisma.organizationMember.update({
        where: { id: candidate.id },
        data: { role: "OWNER" },
      })
    }
    organizationOwners.entries.push({
      kind: "promoted",
      id: candidate.id,
      email: candidate.user.email,
      orgSlug: org.slug,
      from: candidate.role,
      to: "OWNER",
    })
    organizationOwners.promoted++
  }

  return {
    dryRun,
    workspaceMembers,
    organizationMembers,
    organizationOwners,
    totalChanged:
      workspaceMembers.changed + organizationMembers.changed + organizationOwners.promoted,
    totalSkipped:
      workspaceMembers.skipped + organizationMembers.skipped + organizationOwners.alreadyOwned,
  }
}
