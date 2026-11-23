import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import { isTransientConnectionError, retryTransientRead, RETRY_DELAY_MS } from "./db-retry"

/** Builds the error Prisma renders when adapter-pg maps a driver failure. */
function mappedError(code: string, message: string, kind: string): Error {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "test",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { kind } } },
  })
}

const MAPPED = {
  P1001: mappedError("P1001", "Can't reach database server at `db.example.invalid`:`5432`", "DatabaseNotReachable"),
  P1008: mappedError("P1008", "Operation has timed out", "SocketTimeout"),
  P1017: mappedError("P1017", "Server has closed the connection.", "ConnectionClosed"),
}

describe("isTransientConnectionError: adapter-pg mapped Prisma errors", () => {
  it.each(Object.entries(MAPPED))("treats %s as transient", (_code, error) => {
    expect(isTransientConnectionError(error)).toBe(true)
  })

  it.each(["ConnectionClosed", "SocketTimeout", "DatabaseNotReachable"])(
    "recognizes meta.driverAdapterError.cause.kind %s even with an unrelated code and message",
    (kind) => {
      const error = Object.assign(new Error("something opaque"), {
        code: "P2099",
        meta: { driverAdapterError: { cause: { kind } } },
      })
      expect(isTransientConnectionError(error)).toBe(true)
    },
  )

  it("recognizes a mapped error wrapped in a cause chain", () => {
    expect(isTransientConnectionError(new Error("outer", { cause: MAPPED.P1017 }))).toBe(true)
  })

  it.each([
    ["P2002 unique", Object.assign(new Error("Unique constraint failed"), { code: "P2002" })],
    ["P2025 not found", Object.assign(new Error("not found"), { code: "P2025" })],
    ["P2034 write conflict", Object.assign(new Error("Transaction failed due to a write conflict"), { code: "P2034" })],
    ["P1000 auth", Object.assign(new Error("Authentication failed"), { code: "P1000" })],
    ["P1010 denied", Object.assign(new Error("denied access"), { code: "P1010" })],
    [
      "adapter kind for auth",
      Object.assign(new Error("x"), { code: "P1000", meta: { driverAdapterError: { cause: { kind: "AuthenticationFailed" } } } }),
    ],
    [
      "adapter kind for unique violation",
      Object.assign(new Error("x"), { code: "P2002", meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation" } } } }),
    ],
  ])("does not treat %s as transient", (_name, error) => {
    expect(isTransientConnectionError(error)).toBe(false)
  })
})

describe("retryTransientRead", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, "random").mockReturnValue(0)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const run = async (
    operation: string,
    query: (args: unknown) => Promise<unknown>,
    transaction?: { kind: string },
  ) => {
    const promise = retryTransientRead({ operation, args: { where: { id: 1 } }, query, __internalParams: { transaction } })
    // Attach the handler before advancing timers so a rejection is never unhandled.
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 200)
    return settled
  }

  it.each(Object.entries(MAPPED))("retries a read once after mapped %s and returns the second result", async (_code, error) => {
    const query = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce("ok")
    const result = await run("findMany", query)
    expect(result).toEqual({ value: "ok" })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query).toHaveBeenNthCalledWith(2, { where: { id: 1 } })
  })

  it("retries at most once; the second error escapes unchanged", async () => {
    const second = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })
    const query = vi.fn().mockRejectedValueOnce(MAPPED.P1017).mockRejectedValueOnce(second)
    expect(await run("findFirst", query)).toEqual({ error: second })
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("does not retry non-transient errors", async () => {
    const error = Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    const query = vi.fn().mockRejectedValue(error)
    expect(await run("findMany", query)).toEqual({ error })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany",
    "$queryRaw",
    "$executeRaw",
    "$queryRawUnsafe",
    "$executeRawUnsafe",
  ])("never retries %s", async (operation) => {
    const query = vi.fn().mockRejectedValue(MAPPED.P1017)
    expect(await run(operation, query)).toEqual({ error: MAPPED.P1017 })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each(["itx", "batch"])("never retries a read that runs inside a %s transaction", async (kind) => {
    const query = vi.fn().mockRejectedValue(MAPPED.P1017)
    expect(await run("findMany", query, { kind })).toEqual({ error: MAPPED.P1017 })
    expect(query).toHaveBeenCalledTimes(1)
  })
})
