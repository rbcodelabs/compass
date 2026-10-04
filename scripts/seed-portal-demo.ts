#!/usr/bin/env node
/**
 * Local-dev only. Seeds a workspace whose PUBLIC portal roadmap has something
 * to render: a workspace with `roadmapPublic` on and one roadmap item in each
 * stored portal horizon (NOW, LAUNCHING, NEXT, LATER, SHIPPED), so every
 * public column — including the merged "Now" and "Coming Up" ones — is
 * populated.
 *
 * No user or workspace member is created: the portal is unauthenticated, so
 * none is needed. Authenticated app pages will NOT work against this data.
 *
 * Idempotent: re-running updates in place rather than duplicating.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-portal-demo.ts
 *   → http://localhost:<port>/portal/demo/acme/roadmap
 *
 * Works against any Postgres reachable through DATABASE_URL, including the
 * dev-postgres / dev-builder homelab boxes. The schema must already exist
 * (`DATABASE_URL=...?schema=compass_dev prisma db push`) — `lib/db` reads the
 * `compass_dev` schema in development, not `public`.
 */
import getPrisma from "../lib/db"

if (!process.env.DATABASE_URL) {
  console.error("refusing to run without DATABASE_URL (local dev only)")
  process.exit(1)
}

const ORG_SLUG = "demo"
const WORKSPACE_SLUG = "acme"

const ITEMS: { title: string; description: string; horizon: string }[] = [
  { title: "Single sign-on for teams", description: "Sign in with your company identity provider.", horizon: "NOW" },
  { title: "Faster dashboard loading", description: "Cut dashboard load time in half.", horizon: "NOW" },
  { title: "Mobile app beta", description: "Rolling out to early testers.", horizon: "LAUNCHING" },
  { title: "Custom report builder", description: "Build and schedule your own reports.", horizon: "NEXT" },
  { title: "Slack notifications", description: "Get updates where your team already works.", horizon: "NEXT" },
  { title: "Public API v2", description: "A cleaner, faster developer API.", horizon: "LATER" },
  { title: "Audit log export", description: "Download a full history of workspace activity.", horizon: "LATER" },
  { title: "Dark mode", description: "Easier on the eyes.", horizon: "SHIPPED" },
  { title: "CSV import", description: "Bring your data in with one upload.", horizon: "SHIPPED" },
]

async function main() {
  const prisma = getPrisma()

  const org =
    (await prisma.organization.findUnique({ where: { slug: ORG_SLUG } })) ??
    (await prisma.organization.create({ data: { slug: ORG_SLUG, name: "Demo Org (local)" } }))

  let workspace = await prisma.workspace.findFirst({
    where: { organizationId: org.id, slug: WORKSPACE_SLUG },
  })
  if (!workspace) {
    workspace = await prisma.workspace.create({
      data: { organizationId: org.id, slug: WORKSPACE_SLUG, name: "Acme", roadmapPublic: true },
    })
  } else if (!workspace.roadmapPublic) {
    workspace = await prisma.workspace.update({
      where: { id: workspace.id },
      data: { roadmapPublic: true },
    })
  }

  for (const [index, item] of ITEMS.entries()) {
    const existing = await prisma.roadmapItem.findFirst({
      where: { workspaceId: workspace.id, title: item.title },
    })
    const data = {
      description: item.description,
      horizon: item.horizon,
      status: "ACTIVE",
      isPrivate: false,
      sortOrder: index + 1,
      updatedAt: new Date(),
    }
    if (existing) {
      await prisma.roadmapItem.update({ where: { id: existing.id }, data })
    } else {
      await prisma.roadmapItem.create({ data: { workspaceId: workspace.id, title: item.title, ...data } })
    }
  }

  console.log(`seeded ${ITEMS.length} roadmap items → /portal/${ORG_SLUG}/${WORKSPACE_SLUG}/roadmap`)
  await prisma.$disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
