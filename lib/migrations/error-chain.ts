/**
 * Error reporting and connection-retry helpers for the migration status check and migration commands.
 *
 * Why this exists: a deploy failed with
 *   [migrate] {"event":"crashed","message":"\nInvalid `prisma.workspace.findUnique()` invocation:\n\n\n"}
 * and nothing else. The real failure (a driver error with no message, consistent with a failed connect) was in `cause`, `code` or
 * `AggregateError.errors`, all of which the old handler dropped. `describeErrorChain` keeps them, bounded, as plain JSON.
 *
 * Nothing here may print a credential. DSQL auth tokens are presigned URLs (`X-Amz-*` query parameters), and a connection string can carry a
 * password, so every string that leaves this module goes through `redact`.
 */

/** How deep `cause` is followed, and how many AggregateError members are kept. Enough for driver -> adapter -> Prisma, never unbounded. */
export const MAX_CAUSE_DEPTH = 4
export const MAX_AGGREGATE_ERRORS = 5
const MAX_STRING = 2000

const SECRET_KEYS = "password|passwd|pwd|token|secret|x-migration-secret|x-vercel-protection-bypass|authorization"
const SECRET_META_KEY = new RegExp(SECRET_KEYS, "i")
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  // Consume the whole quoted value before the unquoted rule: spaces, commas and escaped quotes can all belong to a credential.
  [new RegExp(String.raw`(\\?["']?\b[\w-]*?(?:${SECRET_KEYS})\\?["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|\\"(?:\\\\.|[^\\]|\\(?!"))*(?:\\"|$)|\\'(?:\\\\.|[^\\]|\\(?!'))*(?:\\'|$))`, "gi"), "$1[redacted]"],
  // postgres://user:password@host/db and postgresql://...
  [/\b(postgres(?:ql)?:\/\/)[^\s"`]+/gi, "$1[redacted]"],
  // DSQL / SigV4 presigned token parts, wherever they appear, in any case.
  [/\b(x-amz-[a-z-]+)=[^&\s"'`]+/gi, "$1=[redacted]"],
  // key=value / key: value / "key":"value" (also backslash-escaped JSON) secrets in libpq strings, headers, JSON or error text. The key may be
  // the tail of a longer name (access_token, db_password). An optional "Bearer " / "Basic " scheme is swallowed with the credential.
  [new RegExp(`(\\\\?["']?\\b[\\w-]*?(?:${SECRET_KEYS})\\\\?["']?\\s*[:=]\\s*\\\\?["']?)(?:(?:bearer|basic)\\s+)?[^\\s&,"'\`}\\\\]+`, "gi"), "$1[redacted]"],
]

export function redact(value: string): string {
  let out = value
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…[truncated]` : out
}

export type ErrorDescription = {
  name?: string
  message?: string
  code?: string | number
  errno?: string | number
  syscall?: string
  address?: string
  port?: number
  /** Prisma known-request errors */
  meta?: unknown
  /** Prisma errors */
  clientVersion?: string
  /** AggregateError members, at most MAX_AGGREGATE_ERRORS */
  errors?: ErrorDescription[]
  /** Set when AggregateError had more members than were kept */
  errorsOmitted?: number
  cause?: ErrorDescription
  /** Set when the chain was cut at MAX_CAUSE_DEPTH */
  causeTruncated?: true
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/**
 * Prisma 7 wraps a driver-adapter failure as PrismaClientKnownRequestError with `meta.driverAdapterError`: a DriverAdapterError whose
 * `cause` is the adapter's mapped error, e.g. { kind: "DatabaseNotReachable", host, port } or { kind: "postgres", originalCode, originalMessage }.
 * Prisma does not set `cause` on its own errors, so this is where the real failure lives. Keep its scalar fields, redacted.
 */
function describeDriverAdapterError(value: unknown): Record<string, unknown> | undefined {
  if (!isObject(value)) return undefined
  const out: Record<string, unknown> = {}
  if (typeof value.name === "string") out.name = redact(value.name)
  if (typeof value.message === "string" && value.message) out.message = redact(value.message)
  if (isObject(value.cause)) {
    const cause: Record<string, unknown> = {}
    for (const key of ["kind", "code", "originalCode", "originalMessage", "message", "host", "port", "reason", "severity", "detail", "hint"]) {
      const field = value.cause[key]
      if (typeof field === "string") cause[key] = redact(field)
      else if (typeof field === "number") cause[key] = field
    }
    out.cause = cause
  }
  return out
}

/** Prisma `meta` is a small record (target, modelName, driverAdapterError...). Keep scalars, short arrays and the adapter error; drop other objects. */
function safeMeta(meta: unknown): unknown {
  if (!isObject(meta)) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta).slice(0, 20)) {
    const safeKey = redact(key)
    if (SECRET_META_KEY.test(key)) out[safeKey] = "[redacted]"
    else if (key === "driverAdapterError") {
      const described = describeDriverAdapterError(value)
      if (described) out[safeKey] = described
    } else if (typeof value === "string") out[safeKey] = redact(value)
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[safeKey] = value
    else if (Array.isArray(value)) out[safeKey] = value.slice(0, 10).map((v) => (typeof v === "string" ? redact(v) : typeof v === "number" ? v : String(typeof v)))
  }
  return out
}

/**
 * Describes an error and its whole chain as plain JSON: name, message, code, network fields, Prisma meta/clientVersion,
 * AggregateError.errors and `cause`, depth-bounded and with every string redacted. Non-Error values are described by their string form.
 * Never includes `stack` (noise in a one-line log, and stacks can carry interpolated values).
 */
export function describeErrorChain(error: unknown, depth = 0, ancestors: Set<unknown> = new Set()): ErrorDescription {
  if (!isObject(error)) return { message: redact(String(error)) }
  // Only a real loop (the error is its own ancestor) is circular; the same error reached through two siblings is described twice.
  if (ancestors.has(error)) return { message: "[circular]" }
  ancestors.add(error)
  try {
    return describeOne(error, depth, ancestors)
  } finally {
    ancestors.delete(error)
  }
}

function describeOne(error: Record<string, unknown>, depth: number, ancestors: Set<unknown>): ErrorDescription {

  const out: ErrorDescription = {}
  if (typeof error.name === "string") out.name = redact(error.name)
  if (typeof error.message === "string") out.message = redact(error.message)
  if (typeof error.code === "string" || typeof error.code === "number") out.code = typeof error.code === "string" ? redact(error.code) : error.code
  if (typeof error.errno === "string" || typeof error.errno === "number") out.errno = typeof error.errno === "string" ? redact(error.errno) : error.errno
  if (typeof error.syscall === "string") out.syscall = redact(error.syscall)
  if (typeof error.address === "string") out.address = redact(error.address)
  if (typeof error.port === "number") out.port = error.port
  if ("meta" in error) {
    const meta = safeMeta(error.meta)
    if (meta !== undefined) out.meta = meta
  }
  if (typeof error.clientVersion === "string") out.clientVersion = redact(error.clientVersion)

  if (Array.isArray(error.errors)) {
    if (depth >= MAX_CAUSE_DEPTH) out.causeTruncated = true
    else {
      out.errors = error.errors.slice(0, MAX_AGGREGATE_ERRORS).map((member) => describeErrorChain(member, depth + 1, ancestors))
      if (error.errors.length > MAX_AGGREGATE_ERRORS) out.errorsOmitted = error.errors.length - MAX_AGGREGATE_ERRORS
    }
  }
  if ("cause" in error && error.cause !== undefined) {
    if (depth >= MAX_CAUSE_DEPTH) out.causeTruncated = true
    else out.cause = describeErrorChain(error.cause, depth + 1, ancestors)
  }
  return out
}

/** Socket-level failures to establish or keep a connection. ENOTFOUND/EAI_AGAIN cover a DNS blip while an ECS task is starting. */
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"])
/** adapter-pg's mapping of the same socket errors, found in Prisma's meta.driverAdapterError.cause.kind. */
const ADAPTER_CONNECTION_KINDS = new Set(["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout"])
const CONNECTION_MESSAGE = /connection terminated/i

/**
 * True when the error, or anything in its cause / AggregateError / Prisma driverAdapterError chain, is a connection-establishment failure:
 * one of CONNECTION_CODES, an AggregateError (Node's happy-eyeballs connect failure across addresses, which has an empty message),
 * pg's "Connection terminated ...", or an adapter-pg DatabaseNotReachable / ConnectionClosed / SocketTimeout.
 * Anything else (SQL errors, P2021, permission errors, a statement timeout) is not.
 *
 * The failure line above (an "Invalid `prisma.workspace.findUnique()` invocation:" header and an empty body) is what Prisma 7.8 throws when
 * Node's dual-stack connect fails: the AggregateError has an empty message but `code` ECONNREFUSED / ETIMEDOUT, adapter-pg cannot map it
 * (no syscall/errno) and rethrows it raw, and Prisma wraps any error with a string `code` as PrismaClientKnownRequestError keeping that
 * code. Observed on 2026-11-13 with the real client against an unreachable localhost; the CONNECTION_CODES check catches it.
 * Still unrecognisable: an error with no code at all (Prisma then wraps it as PrismaClientUnknownRequestError with no `cause`). The old
 * crash line did not log `code`, so which code that failure carried is not on record; the 048 soft-fail covers that path anyway.
 */
export function isConnectionError(error: unknown, depth = 0, seen: Set<unknown> = new Set()): boolean {
  if (!isObject(error) || depth > MAX_CAUSE_DEPTH || seen.has(error)) return false
  seen.add(error)
  if (typeof error.code === "string" && CONNECTION_CODES.has(error.code)) return true
  if (error.name === "AggregateError" || error instanceof AggregateError) return true
  if (typeof error.message === "string" && CONNECTION_MESSAGE.test(error.message)) return true
  const adapterKind = isObject(error.meta) && isObject(error.meta.driverAdapterError) && isObject(error.meta.driverAdapterError.cause) ? error.meta.driverAdapterError.cause.kind : undefined
  if (typeof adapterKind === "string" && ADAPTER_CONNECTION_KINDS.has(adapterKind)) return true
  if (Array.isArray(error.errors) && error.errors.some((member) => isConnectionError(member, depth + 1, seen))) return true
  if ("cause" in error && isConnectionError(error.cause, depth + 1, seen)) return true
  return false
}

/**
 * The one line a migration command prints when the command crashes. `message` stays first-level and unchanged in shape (existing log
 * searches key on it); `error` carries the full described chain.
 */
export function formatCrashLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `[migrate] ${JSON.stringify({ event: "crashed", message: redact(message), error: describeErrorChain(error) })}`
}

export type RetryOptions = {
  /** Delay before the single retry. */
  delayMs?: number
  /** Called once, before the retry, with the error that triggered it. */
  onRetry?: (error: unknown) => void
  sleep?: (ms: number) => Promise<void>
}

/**
 * Runs `fn`; if it throws a connection error, waits `delayMs` and runs it exactly once more. A non-connection error, or a second failure,
 * is rethrown unchanged. Only for read-only calls (the status check), never for applying a migration.
 */
export async function retryOnceOnConnectionError<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { delayMs = 2000, onRetry, sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options
  try {
    return await fn()
  } catch (error) {
    if (!isConnectionError(error)) throw error
    onRetry?.(error)
    await sleep(delayMs)
    return fn()
  }
}
