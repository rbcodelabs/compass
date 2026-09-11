import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { PmInterviewError } from "@/lib/pm-interview-service"
import { readBoundedResearchJson, ResearchRequestBodyError } from "@/lib/research-request"
import { ResearchSessionError } from "@/lib/research-session"

export const readPmRouteBody = readBoundedResearchJson

export async function pmRouteContext(request: Request) {
  const session = await auth()
  if (!session?.user?.id) throw new PmInterviewError("Unauthorized", 401)
  const url = new URL(request.url)
  const orgSlug = url.searchParams.get("orgSlug")
  const workspaceSlug = url.searchParams.get("workspaceSlug")
  if (!orgSlug || !workspaceSlug) throw new PmInterviewError("Workspace is required", 400)
  return { actor: { userId: session.user.id }, scope: { orgSlug, workspaceSlug } }
}

export function pmRouteError(error: unknown) {
  if (error instanceof PmInterviewError) return NextResponse.json({ error: error.message }, { status: error.status })
  if (error instanceof ResearchRequestBodyError || error instanceof ResearchSessionError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error("[pm-interview] request failed", error)
  return NextResponse.json({ error: "PM interview unavailable" }, { status: 500 })
}
