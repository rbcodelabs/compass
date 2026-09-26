/**
 * Workspace *creation*.
 *
 * `lib/workspace.ts` holds the read helpers (getWorkspace, getOrgWorkspaces,
 * getUserWorkspaces); this module holds the one write that more than one
 * surface needs. It was lifted verbatim out of the MCP `create_workspace`
 * handler (app/api/mcp/route.ts) when the org-settings page gained a
 * "Create workspace" form, because the MCP tool is denied to agent API keys
 * and the onboarding wizard is unreachable once you already have a membership
 * — leaving no browser path to add a workspace at all.
 *
 * ── What this module deliberately does NOT do ────────────────────────────────
 * Authorization. The MCP tool is gated by the declarative table in
 * lib/mcp-tool-gates.ts (`assertOrgAdminBySlug` plus an agent-identity DENY);
 * the server action is gated by `resolveOrgAdmin`. Those two gates are
 * different trust boundaries with different failure shapes, and folding either
 * into this function would either weaken one or silently double-check the
 * other. Every caller must gate before calling.
 *
 * ── Why a result union instead of throws ─────────────────────────────────────
 * Both callers need the "org missing" and "slug taken" outcomes as *data*: the
 * MCP handler renders them through `fail()`, and a Server Action cannot throw
 * them because Next replaces a thrown action error's message in production
 * builds (see the header comment in app/[orgSlug]/settings/actions.ts). Genuine
 * faults — a dropped connection, schema drift — are left to throw.
 */

import { revalidatePath } from "next/cache"
import getPrisma from "@/lib/db"
import { normalizeWorkspaceRole } from "@/lib/roles"

export interface CreateWorkspaceInput {
  /** Slug of the organization the workspace belongs to. */
  orgSlug: string
  /** Human-readable name. Trimmed before write. */
  name: string
  /** URL slug. Expected to already satisfy /^[a-z0-9-]+$/ (callers validate). */
  slug: string
  /** Optional description. Trimmed before write. */
  description?: string
}

export interface CreatedWorkspace {
  id: string
  name: string
  slug: string
  description: string | null
}

/**
 * `code` lets a caller branch without matching on prose; `error` carries the
 * exact sentence the MCP tool has always returned, so its output contract is
 * unchanged.
 */
export type CreateWorkspaceFailureCode = "ORG_NOT_FOUND" | "SLUG_TAKEN"

export type CreateWorkspaceResult =
  | { ok: true; workspace: CreatedWorkspace }
  | { ok: false; code: CreateWorkspaceFailureCode; error: string }

/** One wording for the duplicate-slug outcome, whichever path detects it. */
function slugTakenMessage(slug: string, orgName: string): string {
  return `A workspace with slug "${slug}" already exists in organization "${orgName}".`
}

/**
 * True for a Prisma unique-constraint violation (P2002) naming the workspace
 * slug index.
 *
 * Deliberately narrow. Workspace has exactly one other unique index — its
 * primary key — and a P2002 on `id` would mean `gen_random_uuid()` collided,
 * which is not a duplicate slug and must not be reported as one. Prisma
 * reports the offending columns in `meta.target`; when a driver omits it we
 * fall back to treating the violation as the slug conflict, because on this
 * table there is no other plausible candidate and a "slug already exists"
 * message is a far better outcome than an unhandled 500.
 */
function isWorkspaceSlugConflict(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== "P2002"
  ) {
    return false
  }
  const target = (error as { meta?: { target?: unknown } }).meta?.target
  if (Array.isArray(target)) {
    return target.some((column) => String(column).includes("slug"))
  }
  if (typeof target === "string") {
    return target.includes("slug")
  }
  return true
}

/**
 * Creates a workspace inside an organization and seeds its membership from the
 * organization's members.
 *
 * Callers MUST have already authorized the actor as an admin of `orgSlug`.
 */
export async function createWorkspaceInOrg({
  orgSlug,
  name,
  slug,
  description,
}: CreateWorkspaceInput): Promise<CreateWorkspaceResult> {
  const prisma = getPrisma()

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true },
  })
  if (!org) {
    return {
      ok: false,
      code: "ORG_NOT_FOUND",
      error: `No organization found with slug "${orgSlug}".`,
    }
  }

  // Fast path for the common case, so the user gets a sentence naming the
  // organization rather than a bare constraint violation. This is NOT the
  // enforcement boundary — `@@unique([organizationId, slug])` on Workspace is
  // backed by a real index (`workspaces_organization_id_slug_key`, created in
  // 001_init), and that is what actually holds under concurrency. The window
  // between this read and the create below is small but real, so the insert
  // is wrapped to map the loser of that race onto the same SLUG_TAKEN result
  // instead of letting a raw P2002 escape as an unhandled fault.
  const existing = await prisma.workspace.findFirst({
    where: { organizationId: org.id, slug },
    select: { id: true },
  })
  if (existing) {
    return { ok: false, code: "SLUG_TAKEN", error: slugTakenMessage(slug, org.name) }
  }

  let workspace
  try {
    workspace = await prisma.workspace.create({
      data: {
        organizationId: org.id,
        name: name.trim(),
        slug,
        description: description?.trim(),
      },
    })
  } catch (error) {
    if (isWorkspaceSlugConflict(error)) {
      return { ok: false, code: "SLUG_TAKEN", error: slugTakenMessage(slug, org.name) }
    }
    throw error
  }

  // Add all org members as workspace members so the workspace is
  // immediately accessible in the UI. Without this, getWorkspace()
  // filters by membership and returns null → 404.
  const orgMembers = await prisma.organizationMember.findMany({
    where: { organizationId: org.id },
    select: { userId: true, role: true },
  })
  if (orgMembers.length > 0) {
    await prisma.workspaceMember.createMany({
      data: orgMembers.map((m) => ({
        workspaceId: workspace.id,
        userId: m.userId,
        // Org and workspace roles are different domains: OrgRole has an
        // OWNER, WorkspaceRole does not. Copying m.role straight across
        // wrote "OWNER" into WorkspaceMember.role, a value outside
        // WorkspaceRole, which then failed resolveWorkspaceAdmin's strict
        // ADMIN check and locked the org owner out of the workspace they
        // had just created.
        role: normalizeWorkspaceRole(m.role),
      })),
      skipDuplicates: true,
    })
  }

  // The MCP caller reaches this through a route handler (a plain Prisma
  // write, not a Server Action), so none of Next's automatic revalidation
  // kicks in. Without this, /dashboard and the workspace sidebar switcher
  // keep serving the stale pre-creation payload from the client-side
  // router cache on a soft nav — the workspace exists in the DB but
  // looks missing until a hard reload. There's no single concrete
  // per-workspace-slug path to target yet (the workspace is brand
  // new), so revalidate /dashboard directly plus the root layout to
  // cover the sidebar switcher on whichever workspace the browsing
  // user currently has open.
  revalidatePath("/dashboard")
  revalidatePath("/", "layout")

  return {
    ok: true,
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      description: workspace.description,
    },
  }
}
