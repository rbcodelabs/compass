/**
 * Opt-in / opt-out for agent control of this browser tab.
 *
 *   POST   { workspaceId, tabId, currentPath? } -> start (or re-start) a session
 *   PATCH  { sessionId, currentPath? }          -> heartbeat / report location
 *   DELETE { sessionId }                        -> user pressed Stop
 *
 * Session-authed; the caller must be a member of the workspace. The session row
 * is what makes a tab addressable by an agent at all.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { workspaceBasePath } from "@/lib/entity-links"
import { endUiSession, heartbeatUiSession, isValidTabId, startUiSession } from "@/lib/ui-control"

export const runtime = "nodejs"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json()
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const pathOrNull = (value: unknown) => (typeof value === "string" && value.startsWith("/") ? value : null)

export async function POST(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const body = await readBody(request)
  if (typeof body.workspaceId !== "string" || !uuid.test(body.workspaceId) || !isValidTabId(body.tabId)) {
    return new Response("workspaceId and tabId are required.", { status: 400 })
  }
  const prisma = getPrisma()
  const workspace = await prisma.workspace.findFirst({
    where: { id: body.workspaceId, members: { some: { userId: session.user.id } } },
    select: { id: true, slug: true, organization: { select: { slug: true } } },
  })
  if (!workspace?.organization) return new Response("Workspace not found.", { status: 404 })
  const row = await startUiSession({
    prisma,
    userId: session.user.id,
    workspaceId: workspace.id,
    tabId: body.tabId,
    currentPath: pathOrNull(body.currentPath),
  })
  return Response.json({
    sessionId: row.id,
    basePath: workspaceBasePath({ orgSlug: workspace.organization.slug, workspaceSlug: workspace.slug }),
  })
}

export async function PATCH(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const body = await readBody(request)
  if (typeof body.sessionId !== "string" || !uuid.test(body.sessionId)) return new Response("sessionId required.", { status: 400 })
  const alive = await heartbeatUiSession({
    prisma: getPrisma(),
    sessionId: body.sessionId,
    userId: session.user.id,
    currentPath: body.currentPath === undefined ? undefined : pathOrNull(body.currentPath),
  })
  return alive ? Response.json({ ok: true }) : new Response("Session ended.", { status: 410 })
}

export async function DELETE(request: Request) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const body = await readBody(request)
  if (typeof body.sessionId !== "string" || !uuid.test(body.sessionId)) return new Response("sessionId required.", { status: 400 })
  await endUiSession({ prisma: getPrisma(), sessionId: body.sessionId, userId: session.user.id })
  return Response.json({ ok: true })
}
