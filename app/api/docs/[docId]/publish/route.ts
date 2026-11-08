import { NextResponse } from "next/server"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { DocPublishError, setDocPublished } from "@/lib/portal-docs/service"

const body = z.object({ published: z.boolean() })

type Route = { params: Promise<{ docId: string }> }

/**
 * Session-gated (Auth.js): publish or unpublish one Doc on the customer portal. Authorization is workspace
 * membership of the doc's workspace, checked inside setDocPublished; a portal (customer) session has no
 * Auth.js session and gets 401. Unpublish is immediate: the portal reads publishedAt on every request, and the
 * portal pages are revalidated here as well.
 */
export async function POST(req: Request, { params }: Route) {
  try {
    const session = await auth()
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const { docId } = await params
    const input = body.parse(await req.json())
    const prisma = getPrisma()
    const result = await setDocPublished(prisma, { userId: session.user.id, docId, published: input.published })

    const workspace = await prisma.workspace.findUnique({
      where: { id: result.workspaceId },
      select: { slug: true, organization: { select: { slug: true } } },
    })
    if (workspace) revalidatePath(`/portal/${workspace.organization.slug}/${workspace.slug}`, "layout")

    return NextResponse.json({ id: result.docId, published: result.published, publishedAt: result.publishedAt })
  } catch (error) {
    if (error instanceof DocPublishError) {
      const status = error.code === "unauthorized" ? 401 : error.code === "not_found" ? 404 : 409
      return NextResponse.json({ error: error.message }, { status })
    }
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    console.error("Unexpected doc publish route error", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
