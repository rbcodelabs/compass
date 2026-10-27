/**
 * The tab's answer to a delivered command. First write wins; a
 * duplicate or a result for a command the caller does not own returns 409.
 */

import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { completeUiCommand, UiControlError } from "@/lib/ui-control"

export const runtime = "nodejs"

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const session = await auth()
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 })
  const { commandId } = await context.params
  if (!uuid.test(commandId)) return new Response("Not found", { status: 404 })
  let body: { ok?: unknown; result?: unknown; error?: unknown }
  try {
    body = await request.json()
  } catch {
    return new Response("Invalid JSON.", { status: 400 })
  }
  try {
    const accepted = await completeUiCommand({
      prisma: getPrisma(),
      commandId,
      userId: session.user.id,
      ok: body.ok === true,
      result: body.result,
      error: typeof body.error === "string" ? body.error : null,
    })
    return accepted ? Response.json({ ok: true }) : new Response("Command is not awaiting a result.", { status: 409 })
  } catch (error) {
    if (error instanceof UiControlError) return new Response(error.message, { status: 413 })
    throw error
  }
}
