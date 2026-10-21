/**
 * Limits shared by the batch-create core (server) and the grid's submit (client).
 * Dependency-free on purpose: `lib/opportunity-batch-create.ts` pulls in Prisma
 * and `node:crypto`, which must not reach a client bundle.
 */

/** Items per call. Agents get a quarter of the human cap. */
export const BATCH_MAX_ITEMS = { human: 100, agent: 25 } as const

/** Characters. A text column has no limit of its own; 100 items must still fit one request. */
export const BATCH_DESCRIPTION_MAX_LENGTH = 10_000

/**
 * Budget for the UTF-8 size of the JSON items in ONE server-action request.
 *
 * Next caps a server-action body at 1 MB by default (`serverActions.bodySizeLimit`;
 * `next.config` does not raise it), and 100 rows with 10,000-character
 * descriptions can reach about 1 MB of text, more once non-ASCII text is
 * escaped. 256 KiB is a quarter of the limit: it leaves room for the action
 * framing and encoding overhead (the budget measures the items, not the wire
 * format), while still carrying 100 ordinary rows (a few hundred bytes each) in
 * a single request. Oversized batches are split into several sequential
 * requests rather than rejected; re-sending a chunk is safe because the
 * client-generated ids make creation idempotent.
 */
export const BATCH_REQUEST_MAX_BYTES = 256 * 1024
