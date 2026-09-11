#!/usr/bin/env node
/**
 * CLI wrapper for the member-role repair passes in lib/normalize-member-roles.ts.
 *
 * Normalizes OrganizationMember.role and WorkspaceMember.role to values inside
 * their TypeScript unions, and makes sure every organization has an OWNER. Both
 * columns are bare VarChar(50) (Aurora DSQL has no enum support), and several
 * writers historically stored out-of-domain values: "OWNER" as a workspace role
 * (the MCP create_workspace tool copying an org role across) and a lowercase
 * "owner" (the admin provisioning endpoint and setup-compass-workspace.ts).
 * Those rows failed the strict ADMIN check in resolveWorkspaceAdmin.
 *
 * Idempotent: a second run reports zero changes.
 *
 * Run (local only):
 *   node --env-file=.env.local --experimental-strip-types scripts/normalize-member-roles.ts --dry-run
 *   node --env-file=.env.local --experimental-strip-types scripts/normalize-member-roles.ts
 *
 * --dry-run reports every change it would make and writes nothing. Always
 * dry-run first and keep the output: it records each row previous value, and is
 * therefore the rollback plan for something that rewrites permission data.
 *
 * This CLI only works against a database reachable with DATABASE_URL, i.e. local
 * Podman Postgres. It cannot be pointed at preview or production: Aurora DSQL
 * auth needs a Vercel OIDC token that only exists inside the Vercel runtime. For
 * those environments POST to /api/admin/normalize-member-roles instead, which
 * runs the identical lib. See that route header for the invocation.
 */

import { PrismaClient } from "@prisma/client"
import { Pool } from "pg"
import { PrismaPg } from "@prisma/adapter-pg"
import { getActiveSchema } from "../lib/schema.ts"
import { injectUpdatedAtExtension } from "../lib/prisma-updated-at.ts"
import { normalizeMemberRoles } from "../lib/normalize-member-roles.ts"

const DRY_RUN = process.argv.includes("--dry-run")
const mark = (label: string) => (DRY_RUN ? "would " + label : "✓")

// A local-only client. lib/db.ts cannot be imported here: it resolves "./schema"
// without a file extension, which the Next bundler accepts but Node ESM does not.
// The updatedAt interceptor is imported from its own relative, extension-bearing
// module so this client matches the one lib/db.ts builds for the app.
function createClient() {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. This script only runs against a directly " +
        "reachable database (local Podman Postgres). For preview or production, " +
        "POST to /api/admin/normalize-member-roles instead."
    )
  }
  const pool = new Pool({ connectionString: url })
  return new PrismaClient({ adapter: new PrismaPg(pool, { schema: getActiveSchema() }) }).$extends(injectUpdatedAtExtension)
}

const prisma = createClient()

console.log(DRY_RUN ? "DRY RUN — no writes will be made." : "LIVE RUN — writing changes.")
console.log("Schema: " + getActiveSchema())
console.log("")

const report = await normalizeMemberRoles(prisma, { dryRun: DRY_RUN })

console.log("Pass 1 — WorkspaceMember.role (" + report.workspaceMembers.scanned + " row(s))")
for (const c of report.workspaceMembers.changes) {
  console.log(
    "  " + mark("fix") + " " + c.email + " in workspace " + c.scope +
      ": " + JSON.stringify(c.from) + " becomes " + JSON.stringify(c.to)
  )
}
console.log("  fixed: " + report.workspaceMembers.changed + ", already valid: " + report.workspaceMembers.skipped)
console.log("")

console.log("Pass 2 — OrganizationMember.role (" + report.organizationMembers.scanned + " row(s))")
for (const c of report.organizationMembers.changes) {
  console.log(
    "  " + mark("fix") + " " + c.email + " in org " + c.scope +
      ": " + JSON.stringify(c.from) + " becomes " + JSON.stringify(c.to)
  )
}
console.log("  fixed: " + report.organizationMembers.changed + ", already valid: " + report.organizationMembers.skipped)
console.log("")

console.log("Pass 3 — organizations without an OWNER (" + report.organizationOwners.scanned + " org(s))")
for (const e of report.organizationOwners.entries) {
  if (e.kind === "skipped-empty") {
    console.log("  skip " + e.orgSlug + ": org has no members, nobody to promote")
  } else {
    console.log(
      "  " + mark("promote") + " " + e.email + " in org " + e.orgSlug +
        ": " + JSON.stringify(e.from) + " becomes " + JSON.stringify(e.to)
    )
  }
}
console.log(
  "  promoted: " + report.organizationOwners.promoted +
    ", already had an owner: " + report.organizationOwners.alreadyOwned +
    ", empty orgs skipped: " + report.organizationOwners.emptySkipped
)
console.log("")

console.log(
  (DRY_RUN ? "Dry run complete. Would fix: " : "Done. Fixed: ") + report.totalChanged +
    ", Skipped: " + report.totalSkipped
)
if (DRY_RUN && report.totalChanged > 0) {
  console.log("Re-run without --dry-run to apply.")
}

await prisma.$disconnect()
