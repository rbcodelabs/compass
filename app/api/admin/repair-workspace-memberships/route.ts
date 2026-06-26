// One-time repair endpoint: backfills WorkspaceMember rows for workspaces that
// were created via the MCP create_workspace tool before the membership bug was
// fixed. Finds every workspace in an org whose members set is empty and adds
// all org members to it.
//
// POST /api/admin/repair-workspace-memberships
// Body: { secret: string, orgSlug: string }
//
// Protected by REPAIR_SECRET env var — set it in Vercel before calling.

import { NextRequest, NextResponse } from "next/server"
import getPrisma from "@/lib/db"

export async function POST(req: NextRequest) {
  const repairSecret = process.env.REPAIR_SECRET
  if (!repairSecret) {
    return NextResponse.json({ error: "REPAIR_SECRET not configured" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  if (!body || body.secret !== repairSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { orgSlug } = body
  if (!orgSlug || typeof orgSlug !== "string") {
    return NextResponse.json({ error: "orgSlug is required" }, { status: 400 })
  }

  const prisma = getPrisma()

  const org = await prisma.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true, name: true },
  })
  if (!org) {
    return NextResponse.json({ error: `No org found with slug "${orgSlug}"` }, { status: 404 })
  }

  // Get all org members
  const orgMembers = await prisma.organizationMember.findMany({
    where: { organizationId: org.id },
    select: { userId: true, role: true },
  })
  if (orgMembers.length === 0) {
    return NextResponse.json({ message: "No org members found — nothing to repair" })
  }

  // Find workspaces in this org that have no members
  const workspaces = await prisma.workspace.findMany({
    where: {
      organizationId: org.id,
      members: { none: {} },
    },
    select: { id: true, name: true, slug: true },
  })

  if (workspaces.length === 0) {
    return NextResponse.json({ message: "All workspaces already have members — nothing to repair" })
  }

  const results = []
  for (const ws of workspaces) {
    const created = await prisma.workspaceMember.createMany({
      data: orgMembers.map((m) => ({
        workspaceId: ws.id,
        userId: m.userId,
        role: m.role,
      })),
      skipDuplicates: true,
    })
    results.push({ workspace: ws.slug, membersAdded: created.count })
  }

  return NextResponse.json({ repaired: results })
}
