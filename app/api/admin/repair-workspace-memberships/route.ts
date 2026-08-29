// One-time repair endpoint: backfills WorkspaceMember rows for workspaces that
// were created via the MCP create_workspace tool before the membership bug was
// fixed. Finds every workspace in an org whose members set is empty and adds
// all org members to it.
//
// If the org itself has no members (also created via MCP before the fix),
// pass userEmail to seed the calling user as org OWNER + workspace ADMIN.
//
// POST /api/admin/repair-workspace-memberships
// Body: { secret: string, orgSlug: string, userEmail?: string }
//
// Protected by REPAIR_SECRET env var — set it in Vercel before calling.

import { NextRequest, NextResponse } from "next/server"
import getPrisma from "@/lib/db"
import { normalizeWorkspaceRole } from "@/lib/roles"

export async function POST(req: NextRequest) {
  const repairSecret = process.env.REPAIR_SECRET
  if (!repairSecret) {
    return NextResponse.json({ error: "REPAIR_SECRET not configured" }, { status: 500 })
  }

  const body = await req.json().catch(() => null)
  if (!body || body.secret !== repairSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { orgSlug, userEmail } = body
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
  let orgMembers = await prisma.organizationMember.findMany({
    where: { organizationId: org.id },
    select: { userId: true, role: true },
  })

  // If org has no members (created via MCP before the bug fix), seed from userEmail
  if (orgMembers.length === 0) {
    if (!userEmail || typeof userEmail !== "string") {
      return NextResponse.json({
        error:
          "This org has no members. Pass userEmail to seed the org owner, then memberships will be repaired.",
      }, { status: 400 })
    }

    const user = await prisma.user.findUnique({
      where: { email: userEmail },
      select: { id: true },
    })
    if (!user) {
      return NextResponse.json({ error: `No user found with email "${userEmail}"` }, { status: 404 })
    }

    await prisma.organizationMember.create({
      data: { organizationId: org.id, userId: user.id, role: "OWNER" },
    })
    orgMembers = [{ userId: user.id, role: "OWNER" }]
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
    return NextResponse.json({ message: "Org membership seeded. All workspaces already have members." })
  }

  const results = []
  for (const ws of workspaces) {
    const created = await prisma.workspaceMember.createMany({
      data: orgMembers.map((m) => ({
        workspaceId: ws.id,
        userId: m.userId,
        role: normalizeWorkspaceRole(m.role),
      })),
      skipDuplicates: true,
    })
    results.push({ workspace: ws.slug, membersAdded: created.count })
  }

  return NextResponse.json({ repaired: results })
}
