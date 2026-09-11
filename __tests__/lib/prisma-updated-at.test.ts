/**
 * Unit tests for the `updatedAt` write interceptor in lib/prisma-updated-at.ts.
 *
 * Aurora DSQL has no triggers, so prisma/schema.prisma declares
 * `updatedAt DateTime @default(now())` instead of `@updatedAt`. That covers
 * inserts but nothing bumps the column on an update, and an audit of main found
 * 38 of 82 direct write paths omitting it. The extension closes that gap
 * centrally, so these tests pin the exact contract it promises.
 *
 * No database: `Prisma.defineExtension(args)` returns `(client) => client.$extends(args)`,
 * so handing it a stub whose `$extends` captures its argument yields the real
 * `$allOperations` hook. `stubClient()` then wires that hook into model
 * delegates the way a real client does, so each test reads as an ordinary
 * Prisma call and asserts on the args that reached the database layer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { injectUpdatedAtExtension, MODELS_WITH_UPDATED_AT } from "@/lib/prisma-updated-at"

type Operation = (args: Record<string, unknown>) => Promise<Record<string, unknown>>
type AllOperationsHook = (params: {
  model?: string
  operation: string
  args: Record<string, unknown>
  query: Operation
}) => Promise<Record<string, unknown>>

/** Pulls the real hook out of the extension without constructing a client. */
function allOperationsHook(): AllOperationsHook {
  let captured: { query: { $allModels: { $allOperations: AllOperationsHook } } } | undefined
  const captor = { $extends: (args: typeof captured) => { captured = args; return null } }
  ;(injectUpdatedAtExtension as unknown as (client: typeof captor) => unknown)(captor)
  if (!captured?.query?.$allModels?.$allOperations) {
    throw new Error("injectUpdatedAtExtension no longer registers a query.$allModels.$allOperations hook")
  }
  return captured.query.$allModels.$allOperations
}

/**
 * A fake client: `client.<Model>.<operation>(args)` runs the real hook and
 * records the args that reached the database layer.
 */
function stubClient() {
  const hook = allOperationsHook()
  const reached: { model: string; operation: string; args: Record<string, unknown> }[] = []
  function model(modelName: string) {
    return new Proxy({} as Record<string, Operation>, {
      get: (_target, operation: string) => (args: Record<string, unknown>) =>
        hook({
          model: modelName,
          operation,
          args,
          query: async (finalArgs) => {
            reached.push({ model: modelName, operation, args: finalArgs })
            return finalArgs
          },
        }),
    })
  }
  return { model, reached }
}

const FROZEN_NOW = new Date("2026-09-11T12:00:00.000Z")

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FROZEN_NOW)
  return () => vi.useRealTimers()
})

describe("MODELS_WITH_UPDATED_AT", () => {
  it("is derived from the live datamodel, so it cannot drift from the schema", () => {
    // Sampled rather than snapshotted: a snapshot of all 46 names would have to
    // be re-baselined on every unrelated model addition.
    expect(MODELS_WITH_UPDATED_AT.has("Opportunity")).toBe(true)
    expect(MODELS_WITH_UPDATED_AT.has("Solution")).toBe(true)
    expect(MODELS_WITH_UPDATED_AT.has("Task")).toBe(true)
    // CheckIn and ExperimentResult are append-only and have no updatedAt column.
    expect(MODELS_WITH_UPDATED_AT.has("CheckIn")).toBe(false)
    expect(MODELS_WITH_UPDATED_AT.has("ExperimentResult")).toBe(false)
  })
})

describe("update", () => {
  it("injects updatedAt on a model that has the column", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").update({ where: { id: "opportunity-1" }, data: { title: "Renamed" } })

    expect(reached).toHaveLength(1)
    expect(reached[0].args.data).toEqual({ title: "Renamed", updatedAt: FROZEN_NOW })
  })

  it("leaves a caller-supplied updatedAt alone", async () => {
    const { model, reached } = stubClient()
    const caller = new Date("2020-01-01T00:00:00.000Z")
    await model("Opportunity").update({ where: { id: "opportunity-1" }, data: { title: "Renamed", updatedAt: caller } })

    // The 38 existing call sites that already pass `updatedAt: new Date()`
    // must keep winning; the interceptor is a backstop, not an override.
    expect(reached[0].args.data).toEqual({ title: "Renamed", updatedAt: caller })
  })

  it("treats an explicit updatedAt: undefined as caller-supplied and does not fill it in", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").update({ where: { id: "opportunity-1" }, data: { title: "Renamed", updatedAt: undefined } })

    // An `in` check, not a truthiness check: a caller that deliberately passes
    // undefined is asking Prisma to leave the column untouched.
    expect(reached[0].args.data).toHaveProperty("updatedAt", undefined)
    expect(reached[0].args.data).toEqual({ title: "Renamed", updatedAt: undefined })
  })

  it("does not inject updatedAt on a model without the column", async () => {
    const { model, reached } = stubClient()
    await model("CheckIn").update({ where: { id: "checkin-1" }, data: { note: "Revised" } })

    expect(reached[0].args.data).toEqual({ note: "Revised" })
    expect(reached[0].args.data).not.toHaveProperty("updatedAt")
  })

  it("ignores an operation Prisma reports without a model", async () => {
    const hook = allOperationsHook()
    const reached: Record<string, unknown>[] = []
    // $queryRaw and friends arrive with model: undefined.
    await hook({ operation: "$queryRaw", args: { data: {} }, query: async (a) => { reached.push(a); return a } })

    expect(reached[0]).toEqual({ data: {} })
  })
})

describe("updateMany", () => {
  it("injects updatedAt so bulk writes are covered too", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").updateMany({ where: { workspaceId: "workspace-1" }, data: { status: "ARCHIVED" } })

    expect(reached[0].args.data).toEqual({ status: "ARCHIVED", updatedAt: FROZEN_NOW })
  })

  it("leaves a caller-supplied updatedAt alone on updateMany", async () => {
    const { model, reached } = stubClient()
    const caller = new Date("2020-01-01T00:00:00.000Z")
    await model("Opportunity").updateMany({ where: { workspaceId: "workspace-1" }, data: { status: "ARCHIVED", updatedAt: caller } })

    expect(reached[0].args.data).toEqual({ status: "ARCHIVED", updatedAt: caller })
  })

  it("does not inject on updateMany for a model without the column", async () => {
    const { model, reached } = stubClient()
    await model("CheckIn").updateMany({ where: { keyResultId: "kr-1" }, data: { note: "Revised" } })

    expect(reached[0].args.data).not.toHaveProperty("updatedAt")
  })
})

describe("upsert", () => {
  it("injects into the update branch but not the create branch", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").upsert({
      where: { id: "opportunity-1" },
      create: { id: "opportunity-1", title: "Fresh" },
      update: { title: "Renamed" },
    })

    expect(reached[0].args.update).toEqual({ title: "Renamed", updatedAt: FROZEN_NOW })
    // `@default(now())` already covers the insert; injecting here would be redundant.
    expect(reached[0].args.create).toEqual({ id: "opportunity-1", title: "Fresh" })
    expect(reached[0].args.create).not.toHaveProperty("updatedAt")
  })

  it("leaves a caller-supplied updatedAt alone in the update branch", async () => {
    const { model, reached } = stubClient()
    const caller = new Date("2020-01-01T00:00:00.000Z")
    await model("Opportunity").upsert({
      where: { id: "opportunity-1" },
      create: { id: "opportunity-1", title: "Fresh" },
      update: { title: "Renamed", updatedAt: caller },
    })

    expect(reached[0].args.update).toEqual({ title: "Renamed", updatedAt: caller })
  })

  it("does not inject on upsert for a model without the column", async () => {
    const { model, reached } = stubClient()
    await model("CheckIn").upsert({ where: { id: "checkin-1" }, create: { note: "Fresh" }, update: { note: "Revised" } })

    expect(reached[0].args.update).not.toHaveProperty("updatedAt")
    expect(reached[0].args.create).not.toHaveProperty("updatedAt")
  })
})

describe("operations the interceptor must not touch", () => {
  it("leaves create alone — @default(now()) already covers inserts", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").create({ data: { title: "Fresh" } })

    expect(reached[0].args.data).toEqual({ title: "Fresh" })
    expect(reached[0].args.data).not.toHaveProperty("updatedAt")
  })

  it("leaves createMany alone", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").createMany({ data: [{ title: "A" }, { title: "B" }] })

    expect(reached[0].args.data).toEqual([{ title: "A" }, { title: "B" }])
    expect(reached[0].args.data).not.toContainEqual(expect.objectContaining({ updatedAt: FROZEN_NOW }))
  })

  it.each(["findUnique", "findFirst", "findMany", "count", "aggregate", "groupBy"])(
    "leaves the read operation %s untouched",
    async (operation) => {
      const { model, reached } = stubClient()
      await model("Opportunity")[operation]({ where: { workspaceId: "workspace-1" } })

      expect(reached[0].args).toEqual({ where: { workspaceId: "workspace-1" } })
      expect(reached[0].args).not.toHaveProperty("updatedAt")
    },
  )

  it.each(["delete", "deleteMany"])("leaves the delete operation %s untouched", async (operation) => {
    const { model, reached } = stubClient()
    await model("Opportunity")[operation]({ where: { id: "opportunity-1" } })

    expect(reached[0].args).toEqual({ where: { id: "opportunity-1" } })
  })
})

describe("payload shapes that must not be mutated into", () => {
  it("skips an update with no data key rather than inventing one", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").update({ where: { id: "opportunity-1" } })

    expect(reached[0].args).toEqual({ where: { id: "opportunity-1" } })
    expect(reached[0].args).not.toHaveProperty("data")
  })

  it("does not add updatedAt to an array data payload", async () => {
    const { model, reached } = stubClient()
    // Guards the Array.isArray branch: assigning a named key to an array would
    // silently corrupt the payload Prisma receives.
    await model("Opportunity").updateMany({ where: {}, data: [{ title: "A" }] })

    expect(reached[0].args.data).toEqual([{ title: "A" }])
    expect(Array.isArray(reached[0].args.data)).toBe(true)
  })
})

describe("nested relation writes", () => {
  it("documents that a nested update does NOT get updatedAt injected", async () => {
    const { model, reached } = stubClient()
    await model("Opportunity").update({
      where: { id: "opportunity-1" },
      data: { solutions: { update: { where: { id: "solution-1" }, data: { title: "Renamed" } } } },
    })

    // Known limitation, asserted so it is visible rather than assumed: the hook
    // sees only the top-level operation. The parent Opportunity is bumped; the
    // nested Solution still needs an explicit updatedAt from the call site.
    expect(reached[0].args.data).toMatchObject({ updatedAt: FROZEN_NOW })
    const nested = (reached[0].args.data as { solutions: { update: { data: Record<string, unknown> } } }).solutions.update.data
    expect(nested).not.toHaveProperty("updatedAt")
  })
})
