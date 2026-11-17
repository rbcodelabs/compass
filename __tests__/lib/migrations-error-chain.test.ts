// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import {
  describeErrorChain,
  formatCrashLine,
  isConnectionError,
  MAX_AGGREGATE_ERRORS,
  MAX_CAUSE_DEPTH,
  redact,
  retryOnceOnConnectionError,
} from "@/lib/migrations/error-chain"

/** Node's happy-eyeballs connect failure: an AggregateError with an empty message, one member per address tried. */
function connectAggregateError() {
  const v4 = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED", errno: -111, syscall: "connect", address: "10.0.0.1", port: 5432 })
  const v6 = Object.assign(new Error("connect ETIMEDOUT [fd00::1]:5432"), { code: "ETIMEDOUT", syscall: "connect", address: "fd00::1", port: 5432 })
  return new AggregateError([v4, v6], "")
}

/**
 * A generic wrapper that carries its failure in `cause` (other libraries and the pg pool do this). NOT the shape Prisma 7.8 produces:
 * Prisma sets no `cause`; see prismaKnownAdapterError / prismaUnknownEmpty below for the real shapes.
 */
function prismaWrapping(cause: unknown) {
  return Object.assign(new Error("\nInvalid `prisma.workspace.findUnique()` invocation:\n\n\n", { cause }), {
    name: "PrismaClientUnknownRequestError",
    clientVersion: "7.0.0",
  })
}

const parseCrash = (line: string) => {
  expect(line.startsWith("[migrate] ")).toBe(true)
  return JSON.parse(line.slice("[migrate] ".length)) as { event: string; message: string; error: Record<string, unknown> }
}

describe("describeErrorChain", () => {
  it("keeps name, message, code, network fields and Prisma meta/clientVersion, and follows cause", () => {
    const driver = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" })
    const prisma = Object.assign(new Error("Unique constraint failed", { cause: driver }), {
      name: "PrismaClientKnownRequestError",
      code: "P2002",
      clientVersion: "7.0.0",
      meta: { modelName: "Workspace", target: ["id"], nested: { dropped: true } },
    })
    expect(describeErrorChain(prisma)).toEqual({
      name: "PrismaClientKnownRequestError",
      message: "Unique constraint failed",
      code: "P2002",
      clientVersion: "7.0.0",
      meta: { modelName: "Workspace", target: ["id"] },
      cause: { name: "Error", message: "Connection terminated unexpectedly", code: "57P01" },
    })
  })

  it("lists AggregateError members with their codes and addresses", () => {
    const described = describeErrorChain(connectAggregateError())
    expect(described.name).toBe("AggregateError")
    expect(described.errors).toEqual([
      { name: "Error", message: "connect ECONNREFUSED 10.0.0.1:5432", code: "ECONNREFUSED", errno: -111, syscall: "connect", address: "10.0.0.1", port: 5432 },
      { name: "Error", message: "connect ETIMEDOUT [fd00::1]:5432", code: "ETIMEDOUT", syscall: "connect", address: "fd00::1", port: 5432 },
    ])
  })

  it("caps AggregateError members and cause depth, and survives cycles", () => {
    const many = new AggregateError(Array.from({ length: MAX_AGGREGATE_ERRORS + 3 }, (_, i) => new Error(`e${i}`)), "")
    const described = describeErrorChain(many)
    expect(described.errors).toHaveLength(MAX_AGGREGATE_ERRORS)
    expect(described.errorsOmitted).toBe(3)

    let deep: Error = new Error("bottom")
    for (let i = 0; i < MAX_CAUSE_DEPTH + 3; i++) deep = new Error(`level ${i}`, { cause: deep })
    let node: Record<string, unknown> | undefined = describeErrorChain(deep) as Record<string, unknown>
    let levels = 0
    while (node?.cause) {
      node = node.cause as Record<string, unknown>
      levels++
    }
    expect(levels).toBe(MAX_CAUSE_DEPTH)
    expect(node?.causeTruncated).toBe(true)

    const a = new Error("a") as Error & { cause?: unknown }
    const b = new Error("b", { cause: a })
    a.cause = b
    expect(() => JSON.stringify(describeErrorChain(a))).not.toThrow()
  })

  it("describes non-Error values by their string form", () => {
    expect(describeErrorChain("plain string")).toEqual({ message: "plain string" })
    expect(describeErrorChain(undefined)).toEqual({ message: "undefined" })
  })
})

describe("redaction", () => {
  it("never prints connection strings, presigned DSQL token parts or key=value secrets", () => {
    const token = "abc.dsql.us-east-1.on.aws/?Action=DbConnectAdmin&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261112&X-Amz-Security-Token=SESSIONSECRET&X-Amz-Signature=deadbeef"
    const leaky = Object.assign(new Error(`password authentication failed: postgres://admin:hunter2@db.example:5432/postgres token=${token} password=hunter2`), {
      cause: new Error(`retrying with x-migration-secret: SUPERSECRET`),
    })
    const line = formatCrashLine(leaky)
    for (const secret of ["hunter2", "SESSIONSECRET", "AKIAEXAMPLE", "deadbeef", "SUPERSECRET"]) expect(line).not.toContain(secret)
    expect(line).toContain("postgres://[redacted]")
    expect(line).toContain("X-Amz-Signature=[redacted]")
    expect(redact("no secrets here")).toBe("no secrets here")
  })
})

describe("formatCrashLine (scripts/migrate.ts crash handler)", () => {
  it("prints the whole cause chain, including AggregateError members, as one JSON line", () => {
    const line = formatCrashLine(prismaWrapping(connectAggregateError()))
    expect(line.includes("\n")).toBe(false)
    const parsed = parseCrash(line)
    expect(parsed.event).toBe("crashed")
    expect(parsed.message).toContain("Invalid `prisma.workspace.findUnique()` invocation")
    expect(parsed.error).toMatchObject({
      name: "PrismaClientUnknownRequestError",
      clientVersion: "7.0.0",
      cause: {
        name: "AggregateError",
        errors: [
          { code: "ECONNREFUSED", address: "10.0.0.1", port: 5432 },
          { code: "ETIMEDOUT", address: "fd00::1", port: 5432 },
        ],
      },
    })
  })

  it("handles a thrown non-Error", () => {
    expect(parseCrash(formatCrashLine("boom"))).toEqual({ event: "crashed", message: "boom", error: { message: "boom" } })
  })
})

describe("isConnectionError", () => {
  it.each([
    ["ECONNREFUSED", Object.assign(new Error("x"), { code: "ECONNREFUSED" })],
    ["ETIMEDOUT", Object.assign(new Error("x"), { code: "ETIMEDOUT" })],
    ["ECONNRESET", Object.assign(new Error("x"), { code: "ECONNRESET" })],
    ["AggregateError", connectAggregateError()],
    ["pg Connection terminated", new Error("Connection terminated unexpectedly")],
    ["connection error wrapped by Prisma", prismaWrapping(Object.assign(new Error(""), { code: "ECONNRESET" }))],
  ])("is true for %s", (_label, error) => {
    expect(isConnectionError(error)).toBe(true)
  })

  it.each([
    ["missing table", Object.assign(new Error('relation "x" does not exist'), { code: "42P01" })],
    ["Prisma P2021", Object.assign(new Error("table does not exist"), { code: "P2021" })],
    ["permission denied", Object.assign(new Error("permission denied for schema"), { code: "42501" })],
    ["statement timeout", new Error("Query read timeout")],
    ["Prisma error with no connection cause", prismaWrapping(undefined)],
    ["a string", "ECONNREFUSED"],
  ])("is false for %s", (_label, error) => {
    expect(isConnectionError(error)).toBe(false)
  })
})

describe("retryOnceOnConnectionError", () => {
  const noSleep = vi.fn(async () => undefined)

  it("retries exactly once after a connection error and returns the second result", async () => {
    const fn = vi.fn().mockRejectedValueOnce(connectAggregateError()).mockResolvedValueOnce("ok")
    const onRetry = vi.fn()
    await expect(retryOnceOnConnectionError(fn, { delayMs: 5, onRetry, sleep: noSleep })).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(noSleep).toHaveBeenCalledWith(5)
  })

  it("rethrows the second failure without a third attempt", async () => {
    const second = Object.assign(new Error("again"), { code: "ECONNREFUSED" })
    const fn = vi.fn().mockRejectedValueOnce(Object.assign(new Error("first"), { code: "ECONNRESET" })).mockRejectedValueOnce(second)
    await expect(retryOnceOnConnectionError(fn, { sleep: noSleep })).rejects.toBe(second)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("does not retry a non-connection error", async () => {
    const sqlError = Object.assign(new Error('relation "x" does not exist'), { code: "42P01" })
    const fn = vi.fn().mockRejectedValue(sqlError)
    const onRetry = vi.fn()
    await expect(retryOnceOnConnectionError(fn, { onRetry, sleep: noSleep })).rejects.toBe(sqlError)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it("does not retry on success", async () => {
    const fn = vi.fn().mockResolvedValue(1)
    await expect(retryOnceOnConnectionError(fn, { sleep: noSleep })).resolves.toBe(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

/**
 * The shapes Prisma 7.8 + @prisma/adapter-pg actually produce (read from node_modules on 2026-11-12):
 * - a socket error adapter-pg can map (code + syscall + errno) becomes PrismaClientKnownRequestError with
 *   meta.driverAdapterError = DriverAdapterError { cause: { kind: "DatabaseNotReachable", host, port } } and no `cause`;
 * - an error it cannot map is rethrown raw. Node's dual-stack connect AggregateError (empty message, `code` ECONNREFUSED/ETIMEDOUT, no
 *   syscall/errno) is one; Prisma wraps any error with a string `code` as PrismaClientKnownRequestError keeping the code, with an empty
 *   body after the invocation header. That is the connect-failure line (observed 2026-11-13 with the real client against localhost:1);
 * - an unmappable error with no `code` becomes PrismaClientUnknownRequestError with no `cause`, which stays unclassifiable.
 */
function prismaKnownAdapterError(kind: string, extra: Record<string, unknown> = {}) {
  const driverAdapterError = Object.assign(new Error(kind), { name: "DriverAdapterError", cause: { kind, ...extra } })
  return Object.assign(new Error("Can't reach database server"), {
    name: "PrismaClientKnownRequestError",
    code: "P1001",
    clientVersion: "7.8.0",
    meta: { modelName: "Workspace", driverAdapterError },
  })
}
function prismaUnknownEmpty() {
  return Object.assign(new Error("\nInvalid `prisma.workspace.findUnique()` invocation:\n\n\n"), { name: "PrismaClientUnknownRequestError", clientVersion: "7.8.0" })
}

describe("real Prisma 7.8 adapter error shapes", () => {
  it("describes meta.driverAdapterError's mapped cause (kind, host, port), redacted", () => {
    const described = describeErrorChain(prismaKnownAdapterError("DatabaseNotReachable", { host: "abc.dsql.us-east-1.on.aws", port: 5432, originalMessage: "password=hunter2 refused" }))
    expect(described).toMatchObject({
      name: "PrismaClientKnownRequestError",
      code: "P1001",
      clientVersion: "7.8.0",
      meta: { modelName: "Workspace", driverAdapterError: { name: "DriverAdapterError", cause: { kind: "DatabaseNotReachable", host: "abc.dsql.us-east-1.on.aws", port: 5432 } } },
    })
    expect(JSON.stringify(described)).not.toContain("hunter2")
  })

  it.each(["DatabaseNotReachable", "ConnectionClosed", "SocketTimeout"])("treats adapter kind %s as a connection error", (kind) => {
    expect(isConnectionError(prismaKnownAdapterError(kind))).toBe(true)
  })

  it("does not treat a mapped SQL error (kind postgres, TableDoesNotExist) as a connection error", () => {
    expect(isConnectionError(prismaKnownAdapterError("postgres", { originalCode: "42501" }))).toBe(false)
    expect(isConnectionError(prismaKnownAdapterError("TableDoesNotExist"))).toBe(false)
  })

  it.each(["ECONNREFUSED", "ETIMEDOUT"])("classifies the connect-failure shape (real Prisma known-request error, empty body, code %s) as a connection error, and retries it", async (code) => {
    // Built the way Prisma 7.8 builds it from adapter-pg's raw AggregateError: real class, the AggregateError's code, its empty message.
    const crash = () => new Prisma.PrismaClientKnownRequestError("\nInvalid `prisma.workspace.findUnique()` invocation:\n\n\n", { code, clientVersion: "7.8.0", meta: { modelName: "Workspace" } })
    expect(isConnectionError(crash())).toBe(true)
    expect(JSON.parse(formatCrashLine(crash()).slice("[migrate] ".length)).error).toMatchObject({ name: "PrismaClientKnownRequestError", code, meta: { modelName: "Workspace" } })
    const fn = vi.fn().mockRejectedValueOnce(crash()).mockResolvedValueOnce("ok")
    await expect(retryOnceOnConnectionError(fn, { sleep: async () => undefined })).resolves.toBe("ok")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("still cannot classify an unmappable error with no code (unknown request error, empty body, no cause); the 048 soft-fail covers it", () => {
    expect(isConnectionError(prismaUnknownEmpty())).toBe(false)
    const parsed = JSON.parse(formatCrashLine(prismaUnknownEmpty()).slice("[migrate] ".length))
    expect(parsed.error).toEqual({ name: "PrismaClientUnknownRequestError", message: "\nInvalid `prisma.workspace.findUnique()` invocation:\n\n\n", clientVersion: "7.8.0" })
  })
})

describe("redaction, wider forms", () => {
  it("handles lower-case x-amz parameters, JSON-shaped keys, Bearer values and the Vercel bypass header", () => {
    const text = [
      "x-amz-security-token=LOWERSECRET&x-amz-signature=lowersig",
      '{"password":"jsonpw","authorization":"Bearer bearertok","token": "spacedtok"}',
      "x-vercel-protection-bypass: BYPASSVALUE",
      "Authorization: Bearer headertok",
    ].join(" ")
    const out = redact(text)
    for (const secret of ["LOWERSECRET", "lowersig", "jsonpw", "bearertok", "spacedtok", "BYPASSVALUE", "headertok"]) expect(out).not.toContain(secret)
  })
})

describe("the same error reached through two siblings is not a cycle", () => {
  it("describes it twice instead of labelling the second [circular]", () => {
    const shared = Object.assign(new Error("shared"), { code: "ECONNRESET" })
    const described = describeErrorChain(new AggregateError([shared, shared], ""))
    expect(described.errors).toEqual([
      { name: "Error", message: "shared", code: "ECONNRESET" },
      { name: "Error", message: "shared", code: "ECONNRESET" },
    ])
  })
})

describe("redaction, re-review gaps", () => {
  it("covers Basic credentials, keys that end a longer name, and backslash-escaped JSON", () => {
    const out = redact(['Authorization: Basic dXNlcjpwYXNz', "access_token=acctok&db_password=dbpw", '{\\"password\\":\\"escpw\\"}'].join(" "))
    for (const secret of ["dXNlcjpwYXNz", "acctok", "dbpw", "escpw"]) expect(out).not.toContain(secret)
  })

  it("leaves ordinary prose with the word token or password alone", () => {
    expect(redact("password authentication failed for user admin")).toBe("password authentication failed for user admin")
    expect(redact("used 5 tokens")).toBe("used 5 tokens")
  })
})
