/**
 * The URL rules of the comment-origin deep link (TASK-195 S3), kept pure so the client opener and its tests share them.
 *
 * Old links look like `<object page>?comment=<id>`. The unified model shows that thread in the Conversation panel, whose
 * state is `?detail=conversation:<cid>` (components/panels/panel-context.tsx), so the opener rewrites the URL to
 * `?detail=conversation:<cid>&comment=<messageId>`: shareable, refresh-safe, and `comment` stays as "focus this message".
 */

const COMMENT_PARAM = "comment"
const DETAIL_PARAM = "detail"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** True for a well-formed message/comment id; anything else is treated like an unknown id and never sent to the server. */
export function isCommentId(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID.test(value)
}

type UrlParts = { pathname: string; search: string; hash: string }

function href(pathname: string, params: URLSearchParams, hash: string): string {
  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ""}${hash}`
}

/** `?detail=conversation:<cid>&comment=<mid>` with every other parameter and the hash kept. Applying it twice changes nothing. */
export function canonicalCommentDeepLink(input: UrlParts & { conversationId: string; messageId: string }): string {
  const params = new URLSearchParams(input.search)
  params.set(DETAIL_PARAM, `conversation:${input.conversationId}`)
  params.set(COMMENT_PARAM, input.messageId)
  return href(input.pathname, params, input.hash)
}

/** The same URL without `comment`: used for an unknown id, and after the panel is closed so the link cannot reopen it. */
export function withoutCommentParam(input: UrlParts): string {
  const params = new URLSearchParams(input.search)
  params.delete(COMMENT_PARAM)
  return href(input.pathname, params, input.hash)
}
