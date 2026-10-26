// Session-authed upload for files attached to an agent chat message. The file is stored privately under
// agent-uploads/<workspaceId>/<userId>/…; the turn route re-derives that key from the session, so the returned
// `ref` is only ever redeemable by the same user in the same workspace.

import { NextRequest } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { AGENT_UPLOAD_MAX_BYTES, storeAgentUpload } from "@/lib/agent-turn-attachments"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const userId = session.user.id

  const form = await request.formData().catch(() => null)
  const workspaceId = form?.get("workspaceId")
  const file = form?.get("file")
  if (typeof workspaceId !== "string" || !(file instanceof File)) {
    return Response.json({ error: "workspaceId and file are required." }, { status: 400 })
  }
  const workspace = await getPrisma().workspace.findFirst({ where: { id: workspaceId, members: { some: { userId } } }, select: { id: true } })
  if (!workspace) return Response.json({ error: "Workspace not found or access denied." }, { status: 404 })
  if (file.size === 0) return Response.json({ error: "That file is empty." }, { status: 400 })
  if (file.size > AGENT_UPLOAD_MAX_BYTES) {
    return Response.json({ error: `Files must be ${AGENT_UPLOAD_MAX_BYTES / 1024 / 1024} MB or smaller.` }, { status: 413 })
  }

  try {
    const meta = await storeAgentUpload({ workspaceId, userId, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type })
    return Response.json(meta)
  } catch (error) {
    console.error("[agent-attachments] upload failed", error)
    return Response.json({ error: "Upload failed. Try again." }, { status: 500 })
  }
}
