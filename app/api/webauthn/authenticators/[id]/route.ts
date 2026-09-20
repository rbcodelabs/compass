import { NextResponse } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"

type RouteContext = { params: Promise<{ id: string }> }

/**
 * Revoke one of the requesting user's own passkeys.
 *
 * Session-gated via auth() — not the shared-secret checkAuth() pattern used
 * by server-to-server admin ops endpoints. The [id] param is never trusted
 * alone: the lookup is scoped to the requesting user's id, so another
 * user's authenticator id 404s exactly like a nonexistent one.
 */
export async function DELETE(_request: Request, context: RouteContext) {
  const session = await auth()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await context.params
  const prisma = getPrisma()
  const authenticator = await prisma.authenticator.findFirst({
    where: { id, userId: session.user.id },
  })
  if (!authenticator) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  await prisma.authenticator.delete({ where: { id } })
  return NextResponse.json({ success: true })
}
