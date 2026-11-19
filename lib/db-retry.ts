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

/**
 * Prisma codes that adapter-pg's socket mapping renders for a dropped or
 * unreachable connection: P1001 (can't reach), P1008 (timed out), P1017
 * (server closed the connection). The raw errno/code is dropped in the mapping,
 * so the raw-code check above never sees these. Auth (P1000), SQL and
 * conflict codes are deliberately absent.
 */
const TRANSIENT_PRISMA_CODES: ReadonlySet<string> = new Set(["P1001", "P1008", "P1017"]);

/** Adapter error kinds (`meta.driverAdapterError.cause.kind`) for the same failures. */
const TRANSIENT_ADAPTER_KINDS: ReadonlySet<string> = new Set(["ConnectionClosed", "SocketTimeout", "DatabaseNotReachable"]);

const TRANSIENT_MESSAGE =
  /ETIMEDOUT|ECONNRESET|EPIPE|Connection terminated|timeout exceeded when trying to connect|Query read timeout/i;

/** True for a dropped or stalled connection, looking through `cause` chains. */
export function isTransientConnectionError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const err = current as { code?: unknown; message?: unknown; cause?: unknown; meta?: unknown };
    if (typeof err.code === "string" && (TRANSIENT_CODES.has(err.code) || TRANSIENT_PRISMA_CODES.has(err.code))) return true;
    const kind = (err.meta as { driverAdapterError?: { cause?: { kind?: unknown } } } | null | undefined)?.driverAdapterError?.cause?.kind;
    if (typeof kind === "string" && TRANSIENT_ADAPTER_KINDS.has(kind)) return true;
    if (typeof err.message === "string" && TRANSIENT_MESSAGE.test(err.message)) return true;
    current = err.cause;
  }
  return false;
}

export const RETRY_DELAY_MS = 150;

interface RetryParams {
  operation: string;
  args: unknown;
  query: (args: never) => Promise<unknown>;
  /** Prisma passes this to extension callbacks; `transaction` is set inside batch and interactive transactions. */
  __internalParams?: { transaction?: unknown };
}

/**
 * Runs the query; on a transient connection failure repeats it once.
 * Never repeats inside a batch or interactive transaction (the pinned
 * connection is gone, and replay must not be hidden from the caller). Model
 * writes and raw SQL are outside `READ_OPERATIONS`, so they never retry.
 */
export async function retryTransientRead({ operation, args, query, __internalParams }: RetryParams): Promise<unknown> {
  try {
    return await query(args as never);
  } catch (error) {
    if (__internalParams?.transaction || !READ_OPERATIONS.has(operation) || !isTransientConnectionError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS + Math.random() * 100));
    return query(args as never);
  }
}

export const retryReadsExtension = Prisma.defineExtension({
  name: "retryTransientReads",
  query: {
    $allModels: {
      $allOperations: (params) => retryTransientRead(params as unknown as RetryParams),
    },
  },
});
