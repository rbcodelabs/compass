/**
 * Retries a read once when the database connection itself failed.
 *
 * Kept free of `pg` and of any relative import so it can be unit-tested alone
 * (same reasoning as `prisma-updated-at.ts`).
 *
 * Only reads are retried. A connect failure is safe to repeat, but an
 * ECONNRESET or a query timeout on a write can happen *after* the server
 * applied it, so repeating it could double-apply. Writes surface the error.
 */
import { Prisma } from "@prisma/client";

const READ_OPERATIONS: ReadonlySet<string> = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

const TRANSIENT_CODES: ReadonlySet<string> = new Set(["ETIMEDOUT", "ECONNRESET", "EPIPE", "ECONNREFUSED"]);

const TRANSIENT_MESSAGE =
  /ETIMEDOUT|ECONNRESET|EPIPE|Connection terminated|timeout exceeded when trying to connect|Query read timeout/i;

/** True for a dropped or stalled connection, looking through `cause` chains. */
export function isTransientConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const err = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof err.code === "string" && TRANSIENT_CODES.has(err.code)) return true;
    if (typeof err.message === "string" && TRANSIENT_MESSAGE.test(err.message)) return true;
    current = err.cause;
  }
  return false;
}

export const RETRY_DELAY_MS = 150;

export const retryReadsExtension = Prisma.defineExtension({
  name: "retryTransientReads",
  query: {
    $allModels: {
      async $allOperations({ operation, args, query }) {
        try {
          return await query(args);
        } catch (error) {
          if (!READ_OPERATIONS.has(operation) || !isTransientConnectionError(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS + Math.random() * 100));
          return query(args);
        }
      },
    },
  },
});
