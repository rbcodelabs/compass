#!/usr/bin/env node
/**
 * Local-dev / QA only. Puts one tool approval in every state the approval page and chat card can show onto a workspace, so the
 * visual gate can screenshot them. Refuses to run against production or a Vercel environment, and needs the workspace named
 * explicitly. Rows are written through the fixtures in e2e/functional/fixtures/tool-approval.ts (the production registry is
 * empty, so nothing else can raise an approval from a browser).
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-tool-approval-qa.ts <orgSlug>/<workspaceSlug> [adminEmail]
 *
 * Prints the approval page path for each state. Sign in as a workspace admin to see buttons; as a plain member to see the 404.
 */
import getPrisma from "../lib/db"
import { seedDecidedToolApproval, seedHostileToolApproval, seedRichToolApproval, seedToolApproval, type DecidedState } from "../e2e/functional/fixtures/tool-approval"

if (process.env.NODE_ENV === "production" || process.env.VERCEL || process.env.VERCEL_ENV || process.env.PREVIEW_AUTOMATION_ENABLED) {
  console.error("refusing to run: this seeds fake approvals and is for local / homelab development only")
  process.exit(1)
}
const [target, adminEmail] = process.argv.slice(2)
const [orgSlug, workspaceSlug] = (target ?? "").split("/")
if (!orgSlug || !workspaceSlug) {
  console.error("usage: seed-tool-approval-qa.ts <orgSlug>/<workspaceSlug> [adminEmail]")
  process.exit(1)
}

const STATES: DecidedState[] = ["DENIED", "APPLIED", "FAILED", "STALE", "BLOCKED", "UNKNOWN_OUTCOME", "NOT_RUN", "EXPIRED", "APPLYING"]

async function main() {
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({ where: { slug: workspaceSlug, organization: { slug: orgSlug } }, select: { id: true } })
  if (!workspace) throw new Error(`workspace ${target} not found`)
  const admin = adminEmail
    ? await prisma.user.findUnique({ where: { email: adminEmail }, select: { id: true } })
    : (await prisma.workspaceMember.findFirst({ where: { workspaceId: workspace.id, role: "ADMIN" }, select: { user: { select: { id: true } } } }))?.user
  if (!admin) throw new Error("no admin user found; pass an adminEmail")
  const path = (id: string) => `/${orgSlug}/${workspaceSlug}/approvals/${id}`
  const out: Array<[string, string]> = []
  out.push(["PENDING (simple)", path((await seedToolApproval(workspace.id)).requestId)])
  out.push(["PENDING (nested diff)", path((await seedRichToolApproval(workspace.id)).requestId)])
  out.push(["PENDING (long + html)", path((await seedHostileToolApproval(workspace.id)).requestId)])
  for (const state of STATES) out.push([state, path((await seedDecidedToolApproval(workspace.id, state, admin.id)).requestId)])
  for (const [label, p] of out) console.log(`${label.padEnd(24)} ${p}`)
  console.log(`list: /${orgSlug}/${workspaceSlug}/approvals`)
}

main().then(() => process.exit(0), (error) => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
