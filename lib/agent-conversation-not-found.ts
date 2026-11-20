/**
 * The one response for "you cannot read this conversation".
 *
 * A conversation that does not exist, one in another workspace, a private one
 * belonging to someone else, and a malformed id all answer with exactly this
 * (same status, body and headers), so a caller cannot tell them apart. `no-store`
 * keeps a shared cache from replaying a 404 to someone who can read it, or the
 * reverse.
 */
export const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const

export function conversationNotFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain;charset=UTF-8", ...NO_STORE_HEADERS } })
}
