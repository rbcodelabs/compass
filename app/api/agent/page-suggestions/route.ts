/**
 * Screen-responsive starter questions for the empty Agent Rail (TASK-174).
 *
 * Bare API route under `/api/agent/` — exempted from login-redirect middleware
 * by `lib/route-access.ts` so unauthenticated callers receive explicit `401` JSON.
 * Authorizes workspace membership explicitly, checks the server LRU cache first
 * (0 LLM cost on hit), enforces `checkAgentUsageLimit` + a per-user sliding-window
 * cap on uncached generations, and returns quiet empty `suggestions: []` on any
 * limit or upstream failure.
 */

import { NextResponse } from "next/server"
import { auth } from "@/auth"
import { checkAgentUsageLimit } from "@/lib/agent-limits"
import { AGENT_PAGE_URL_MAX_LENGTH } from "@/lib/agent-page-context"
import {
  buildServerSuggestionCacheKey,
  consumePageSuggestionRateLimit,
  getServerCachedSuggestions,
  resolvePageSuggestionContext,
  setServerCachedSuggestions,
} from "@/lib/agent-page-suggestions"
import { generatePageSuggestions } from "@/lib/agent-page-suggestions-model"
import getPrisma from "@/lib/db"

const EMPTY_SUGGESTIONS_PAYLOAD = {
  label: null,
  pageUrl: null,
  revisionKey: null,
  mode: null,
  suggestions: [] as string[],
}

function isMissingColumnError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "P2021" || error.code === "P2022")
  )
}

export async function GET(request: Request) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }
  const userId = session.user.id

  const { searchParams } = new URL(request.url)
  const workspaceId = searchParams.get("workspaceId")?.trim() ?? ""
  const pageUrl = searchParams.get("pageUrl") ?? ""

  if (!workspaceId || !pageUrl.trim()) {
    return NextResponse.json(
      { error: "workspaceId and pageUrl are required." },
      { status: 400 },
    )
  }

  if (pageUrl.length > AGENT_PAGE_URL_MAX_LENGTH) {
    return NextResponse.json(EMPTY_SUGGESTIONS_PAYLOAD)
  }

  const prisma = getPrisma()
  type WorkspaceRow = {
    id: string
    slug: string
    name: string
    thinkingModel?: string | null
    thinkingModelLabels?: string | null
    nowLimit?: number | null
    nextLimit?: number | null
    organization: { slug: string }
  }

  let workspace: WorkspaceRow | null = null
  try {
    workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, members: { some: { userId } } },
      select: {
        id: true,
        slug: true,
        name: true,
        thinkingModel: true,
        thinkingModelLabels: true,
        nowLimit: true,
        nextLimit: true,
        organization: { select: { slug: true } },
      },
    })
  } catch (error) {
    if (!isMissingColumnError(error)) throw error
    workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, members: { some: { userId } } },
      select: {
        id: true,
        slug: true,
        name: true,
        organization: { select: { slug: true } },
      },
    })
  }

  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found or access denied." }, { status: 404 })
  }

  const context = await resolvePageSuggestionContext({
    pageUrl,
    workspace: {
      id: workspace.id,
      orgSlug: workspace.organization.slug,
      workspaceSlug: workspace.slug,
      name: workspace.name,
      thinkingModel: workspace.thinkingModel ?? null,
      thinkingModelLabels: workspace.thinkingModelLabels ?? null,
      nowLimit: workspace.nowLimit ?? null,
      nextLimit: workspace.nextLimit ?? null,
    },
    prisma,
  })

  if (!context) {
    return NextResponse.json(EMPTY_SUGGESTIONS_PAYLOAD)
  }

  const cacheKey = buildServerSuggestionCacheKey(workspace.id, context.path, context.revisionKey)
  const cached = getServerCachedSuggestions(cacheKey)
  if (cached) {
    return NextResponse.json({
      label: context.label,
      pageUrl: context.path,
      revisionKey: context.revisionKey,
      mode: context.mode,
      suggestions: cached,
    })
  }

  const usageLimit = await checkAgentUsageLimit(userId)
  if (!usageLimit.allowed || !consumePageSuggestionRateLimit(userId)) {
    return NextResponse.json({
      label: context.label,
      pageUrl: context.path,
      revisionKey: context.revisionKey,
      mode: context.mode,
      suggestions: [],
    })
  }

  const generated = await generatePageSuggestions({
    prisma,
    workspaceId: workspace.id,
    context,
  })

  if (generated.suggestions.length >= 2) {
    setServerCachedSuggestions(cacheKey, generated.suggestions)
  }

  return NextResponse.json({
    label: context.label,
    pageUrl: context.path,
    revisionKey: context.revisionKey,
    mode: context.mode,
    suggestions: generated.suggestions,
  })
}
