import { z } from "zod"

/**
 * Keyset ("seek") pagination for the `list_*` MCP tools.
 *
 * Why this exists: an unbounded `list_*` tool returns the entire table in one
 * tool result. For a real workspace that is tens of thousands of tokens in a
 * single message, which crowds out the caller's remaining context — and because
 * the response carries no total and no "more remain" signal, an agent cannot
 * tell a complete list from the head of a long one. It processes the first
 * chunk, reports done, and on the next turn starts over from the same head.
 * Bounding the page is only half the fix; the other half is saying loudly, in
 * the human-readable text block, how much was NOT returned.
 *
 * Keyset rather than OFFSET/LIMIT because offset paging over a mutating table
 * both skips and duplicates rows: insert or delete anything ordered before the
 * current page and every later offset shifts. A keyset cursor names the last row
 * actually seen, so the next page resumes from that exact point.
 *
 * Two invariants the caller MUST uphold:
 *
 *   1. The ordering carries a stable `id` tiebreaker — `[{ <key>: dir }, { id: "asc" }]`.
 *      The sort key is never unique (bulk imports give thousands of rows the
 *      same `createdAt`), so without the tiebreaker rows with equal keys come
 *      back in an arbitrary order that differs between identical calls, and a
 *      cursor built from one call is meaningless to the next. This mirrors
 *      invariant #2 in `lib/mcp-recency.ts`, which `recencyOrderBy()` already
 *      satisfies; the point of restating it here is that a tool's *default*
 *      ordering has to satisfy it too.
 *   2. The filter set is pinned into the cursor via `filterFingerprint()` and
 *      rechecked on use. Paging with a cursor minted under different filters
 *      silently skips and repeats rows, which is worse than refusing.
 */

/** Page size when the caller does not ask for one. */
export const KEYSET_PAGE_DEFAULT = 50

/** Hard ceiling on page size, so `limit` can't be used to restore the firehose. */
export const KEYSET_PAGE_MAX = 200

/** The `limit` input schema. Declare on every list tool that supports keyset paging. */
export const keysetLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(KEYSET_PAGE_MAX)
  .optional()
  .describe(
    `Maximum items to return in this page (1-${KEYSET_PAGE_MAX}, default ${KEYSET_PAGE_DEFAULT}). ` +
      "The response always reports the total and whether more remain.",
  )

/** The `cursor` input schema. */
export const keysetCursorSchema = z
  .string()
  .optional()
  .describe(
    "Opaque cursor from a previous response's `nextCursor`, to fetch the next page. " +
      "Repeat the same filters and sort alongside it. Omit to start from the first page.",
  )

const cursorPayloadSchema = z.object({
  v: z.literal(1),
  /** Workspace the cursor was minted against. */
  w: z.string(),
  /** Fingerprint of the filters + sort the cursor was minted under. */
  f: z.string(),
  /** Sort key value of the last row on the previous page, as an ISO timestamp. */
  k: z.string(),
  /** Id of the last row on the previous page. */
  i: z.string(),
  /** How many rows the caller has already been shown, for "showing X-Y of N". */
  s: z.number().int().nonnegative(),
})

export type KeysetCursor = z.infer<typeof cursorPayloadSchema>

/**
 * Stable fingerprint of everything that changes which rows a listing selects or
 * how it orders them. Pinned into the cursor so a mismatched continuation is
 * refused rather than silently skipping and repeating rows.
 */
export function filterFingerprint(filters: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(filters)
      .sort()
      .map((key) => [key, filters[key] ?? null]),
  )
}

export function encodeKeysetCursor(payload: KeysetCursor): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

/** Decode and validate a cursor. Returns null on anything malformed. */
export function decodeKeysetCursor(cursor: string): KeysetCursor | null {
  let payload: KeysetCursor
  try {
    payload = cursorPayloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
  } catch {
    return null
  }
  // A structurally valid cursor carrying an unparseable timestamp would produce
  // an `Invalid Date` keyset bound, which Prisma rejects at query time with a
  // far less actionable error than "invalid cursor".
  if (Number.isNaN(new Date(payload.k).getTime())) return null
  return payload
}

/**
 * Prisma WHERE fragment selecting only rows strictly after `cursor` under the
 * ordering `[{ [sortKey]: direction }, { id: "asc" }]`.
 *
 * `id` is compared with `gt` regardless of `direction` because the tiebreaker is
 * always ascending — it breaks ties *within* one sort-key value, so it does not
 * follow the primary key's direction.
 */
export function keysetAfter(
  sortKey: string,
  direction: "asc" | "desc",
  cursor: KeysetCursor,
): { OR: Record<string, unknown>[] } {
  const boundary = new Date(cursor.k)
  return {
    OR: [
      { [sortKey]: direction === "desc" ? { lt: boundary } : { gt: boundary } },
      { [sortKey]: boundary, id: { gt: cursor.i } },
    ],
  }
}

/**
 * The line appended to a paginated tool's text block.
 *
 * This wording is load-bearing, not decoration. It is the only thing standing
 * between a bounded page and a caller that believes it has seen everything, so
 * it states the range, the total, the number still unseen, and — when more
 * remain — that restarting is the wrong next move.
 */
export function keysetFooter(params: {
  toolName: string
  start: number
  end: number
  total: number
  nextCursor: string | null
}): string {
  const { toolName, start, end, total, nextCursor } = params
  // Paging off the end of a list whose final page was exactly full returns no
  // rows at all. Rendering that as a range ("Showing 4-4 of 4") would claim an
  // item is present in an empty page.
  if (end < start) {
    return `No further items. All ${total} have already been listed.`
  }
  const range = `Showing ${start}-${end} of ${total}.`
  if (!nextCursor) {
    return `${range} End of list - every item has now been listed.`
  }
  return (
    `${range} ${total - end} not yet listed. To continue, call ${toolName} again with ` +
    `cursor: "${nextCursor}" and the same filters and sort. Do NOT start over from the ` +
    `first page - items ${start}-${end} have already been listed.`
  )
}
