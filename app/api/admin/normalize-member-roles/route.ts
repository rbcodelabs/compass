/**
 * One-time-ops admin endpoint: repairs member role data in place.
 *
 * Normalizes OrganizationMember.role and WorkspaceMember.role to values inside
 * their TypeScript unions, and backfills an OWNER for any organization that has
 * none. Both columns are bare VarChar(50) -- Aurora DSQL has no enum support --
 * and several writers historically stored out-of-domain values: "OWNER" as a
 * workspace role, and a lowercase "owner". Those rows failed the strict ADMIN
 * check in resolveWorkspaceAdmin and locked people out of their own workspaces.
 *
 * Why a route and not just the CLI script: scripts/normalize-member-roles.ts
 * needs a directly reachable DATABASE_URL, which only exists for local Podman
 * Postgres. Preview and production run on Aurora DSQL, whose auth needs a Vercel
 * OIDC token that only exists inside the Vercel runtime -- so the repair has to
 * execute server-side, there. Both paths call the identical implementation in
 * lib/normalize-member-roles.ts.
 *
 * Gated by MIGRATION_SECRET, the same trust boundary as the migrate and
 * purge-feedback routes (mirrors their checkAuth()).
 *
 * Invocation (report only, writes nothing):
 *   vercel curl /api/admin/normalize-member-roles --deployment <url> -- -X POST
 *     -H "x-migration-secret: SECRET" -H "Content-Type: application/json"
 *     -d '{"dryRun": true}'
 *
 * Invocation (actually write):
 *   vercel curl /api/admin/normalize-member-roles --deployment <url> -- -X POST
 *     -H "x-migration-secret: SECRET" -H "Content-Type: application/json"
 *     -d '{"dryRun": false}'
 *
 * Safety invariants:
 *   - dryRun DEFAULTS TO TRUE. This is deliberately inverted from the CLI, where
 *     the default is to write and --dry-run opts out. An unparameterized POST,
 *     an empty body, or unparseable JSON all report instead of writing; only an
 *     explicit {"dryRun": false} mutates anything.
 *   - Idempotent. Rows already holding a valid value are skipped without a
 *     write, so a second call reports zero changes.
 *   - The response body is the full change set (previous and next value per
 *     row), so a dry run doubles as the rollback record.
 *   - It only ever rewrites the role column. It creates and deletes nothing.
 */

import { NextRequest, NextResponse } from "next/server"
import getPrisma from "@/lib/db"
import { normalizeMemberRoles } from "@/lib/normalize-member-roles"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function checkAuth(req: NextRequest): boolean {
  const secret = process.env.MIGRATION_SECRET
  if (!secret) return false
  return req.headers.get("x-migration-secret") === secret
}

/** POST body: { dryRun?: boolean } — omitted or unparseable means dryRun: true. */
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => null)
  // Inverted default: writing requires an explicit opt-in.
  const dryRun = body?.dryRun !== false

  const report = await normalizeMemberRoles(getPrisma(), { dryRun })

  return NextResponse.json(report)
}
