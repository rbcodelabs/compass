// "Send to agent" hand-off context, fetched by the Geode bridge picker
// (components/agent/send-to-agent-picker.tsx) so it can post the same
// context the built-in cloud agent gets to `window.__geode.postEvent`.
//
// Bare API route — no workspace layout to lean on for membership, so unlike
// app/[orgSlug]/[workspaceSlug]/agent/page.tsx (which relies on its layout),
// this route checks membership explicitly. Session-authed like the sibling
// /api/agent/turn route; both are exempted from the login-redirect
// middleware by lib/route-access.ts's `/api/agent/` prefix and return their
// own 401 instead of a 302.
import { NextResponse } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { resolveAgentHandoffContext, type AgentHandoffEntityType } from "@/lib/agent-context"

const VALID_ENTITY_TYPES: readonly AgentHandoffEntityType[] = ["solutionPlan", "decision"]

function isValidEntityType(value: string): value is AgentHandoffEntityType {
  return (VALID_ENTITY_TYPES as readonly string[]).includes(value)
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }
  const userId = session.user.id

  const { searchParams } = new URL(request.url)
  const orgSlug = searchParams.get("orgSlug")
  const workspaceSlug = searchParams.get("workspaceSlug")
  const entityType = searchParams.get("entityType")
  const entityId = searchParams.get("entityId")

  if (!orgSlug || !workspaceSlug || !entityType || !entityId || !isValidEntityType(entityType)) {
    return NextResponse.json(
      { error: 'orgSlug, workspaceSlug, entityType ("solutionPlan" | "decision"), and entityId are all required.' },
      { status: 400 }
    )
  }

  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: { slug: workspaceSlug, organization: { slug: orgSlug }, members: { some: { userId } } },
    select: { id: true },
  })
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied." }, { status: 404 })
  }

  const handoff = await resolveAgentHandoffContext({ workspaceId: workspace.id, userId, entityType, entityId })
  if (!handoff) {
    return NextResponse.json({ error: "No approved hand-off context available for this entity." }, { status: 404 })
  }

  return NextResponse.json({
    entityType,
    entityId,
    orgSlug,
    workspaceSlug,
    label: handoff.label,
    summary: handoff.summary,
    suggestedInstruction: handoff.suggestedInstruction,
    promptBlock: handoff.promptBlock,
    sourceUrl: handoff.sourceUrl,
  })
}
