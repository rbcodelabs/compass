import { describe, expect, it } from "vitest"
import { getDsqlPoolOptions } from "./db"
import { isTransientConnectionError } from "./db-retry"

describe("getDsqlPoolOptions", () => {
  it("defaults keep recycling under DSQL's ~60 minute connection cut", () => {
    const o = getDsqlPoolOptions({})
    expect(o).toMatchObject({
      max: 20,
      connectionTimeoutMillis: 10_000,
      maxLifetimeSeconds: 3000,
      query_timeout: 30_000,
      keepAlive: true,
    })
    expect(o.maxLifetimeSeconds).toBeLessThan(60 * 60)
  })

  it("accepts positive integer overrides and ignores junk", () => {
    expect(getDsqlPoolOptions({ DSQL_POOL_MAX: "5", DSQL_MAX_LIFETIME_SECONDS: "15" })).toMatchObject({
      max: 5,
      maxLifetimeSeconds: 15,
    })
    expect(getDsqlPoolOptions({ DSQL_POOL_MAX: "0", DSQL_QUERY_TIMEOUT_MS: "abc", DSQL_CONNECT_TIMEOUT_MS: "-3" })).toMatchObject({
      max: 20,
      query_timeout: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  })
})

describe("isTransientConnectionError", () => {
  it.each([
    [Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })],
    [new Error("Connection terminated due to connection timeout")],
    [new Error("Query read timeout")],
    [new Error("timeout exceeded when trying to connect")],
    [new Error("outer", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) })],
  ])("treats %# as transient", (error) => {
    expect(isTransientConnectionError(error)).toBe(true)
  })

  it.each([
    [new Error('duplicate key value violates unique constraint "x"')],
    [Object.assign(new Error("not found"), { code: "P2025" })],
    ["a string"],
    [null],
    [undefined],
  ])("does not retry %# ", (error) => {
    expect(isTransientConnectionError(error)).toBe(false)
  })
})
