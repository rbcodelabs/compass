import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type { AppPrismaClient } from "@/lib/db"
const mocks = vi.hoisted(() => ({ prisma: {} as Record<string, unknown>, member: vi.fn(), send: vi.fn() }))
vi.mock("@/lib/db", () => ({ default: () => mocks.prisma }))
vi.mock("@/lib/mcp-authz", () => ({ assertWorkspaceMember: mocks.member, getMcpActor: () => ({ userId: "user", purpose: "USER" }) }))
vi.mock("./telemetry", () => ({ sendActivityEvent: mocks.send }))
import { instrumentActivityClient, recordActivation, withActivityCommit, withAnalyticsTool, getMcpActivityPrisma } from "./activity"
import { withToolTransaction } from "@/lib/mcp-tool-db"

describe("atomic opt-in activity", () => {
  beforeEach(() => { vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("COMPASS_ANALYTICS_COLLECTION_STARTED_AT", "2026-01-01T00:00:00Z"); vi.stubEnv("COMPASS_ANALYTICS_EXCLUDED_WORKSPACE_IDS", ""); vi.clearAllMocks(); mocks.send.mockResolvedValue(undefined) })
  afterEach(() => vi.unstubAllEnvs())
  function fixture() {
    const row = { id: "item", workspaceId: "workspace", title: "before" }
    const model = {
      findMany: vi.fn().mockImplementation(() => [{ ...row }]),
      create: vi.fn().mockImplementation(({ data, select }) => { Object.assign(row, data); return select ? { title: row.title, id: row.id } : { ...row } }),
      findUniqueOrThrow: vi.fn().mockImplementation(() => ({ ...row })),
      update: vi.fn().mockImplementation(({ data }) => { Object.assign(row, data); return { ...row } }),
    }
    const tx = { opportunity: model, workspaceActivationState: { upsert: vi.fn(), updateMany: vi.fn() } }
    const transaction = vi.fn().mockImplementation(async fn => fn(tx))
    mocks.prisma = { ...tx, $transaction: transaction }
    const client = instrumentActivityClient(mocks.prisma as unknown as AppPrismaClient, "ui", async () => ({ userId: "user" }))
    return { client, tx, model, transaction }
  }
  it("uses the domain transaction, validates membership and emits after commit", async () => {
    const { client, tx, transaction } = fixture()
    transaction.mockImplementation(async fn => { const result = await fn(tx); expect(mocks.send).not.toHaveBeenCalled(); return result })
    await client.opportunity.update({ where: { id: "item" }, data: { title: "after" } })
    expect(mocks.member).toHaveBeenCalledWith({ userId: "user" }, "workspace")
    expect(tx.workspaceActivationState.updateMany).toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledOnce()
  })
  it("does not emit after rollback even when the caller catches the failure", async () => {
    const { client, tx, transaction } = fixture()
    transaction.mockImplementation(async fn => { await fn(tx); throw new Error("commit conflict") })
    await withActivityCommit(async () => {
      await expect(client.opportunity.update({ where: { id: "item" }, data: { title: "after" } })).rejects.toThrow("commit conflict")
    })
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it("preserves a create projection without exposing the injected ID", async () => {
    const { client } = fixture()
    expect(await client.opportunity.create({ data: { title: "new", workspaceId: "workspace" }, select: { title: true } })).toEqual({ title: "new" })
  })
  it("does not count noops and excludes preview writes", async () => {
    const { client, tx } = fixture()
    await client.opportunity.update({ where: { id: "item" }, data: { title: "before" } })
    expect(tx.workspaceActivationState.upsert).not.toHaveBeenCalled()
    vi.stubEnv("VERCEL_ENV", "preview")
    expect(instrumentActivityClient(mocks.prisma as unknown as AppPrismaClient, "ui", async () => ({ userId: "user" }))).toBe(mocks.prisma)
  })
  it("uses conditional monotonic timestamps and explicit workspace exclusions", async () => {
    const { tx } = fixture()
    const at = new Date()
    await recordActivation(tx as never, "workspace", "learning", at, at)
    expect(tx.workspaceActivationState.updateMany).toHaveBeenCalledWith({ where: { workspaceId: "workspace", OR: [{ learningAt: null }, { learningAt: { lt: at } }] }, data: { learningAt: at, updatedAt: at } })
    vi.stubEnv("COMPASS_ANALYTICS_EXCLUDED_WORKSPACE_IDS", "workspace")
    expect(await recordActivation(tx as never, "workspace", "learning", at, at)).toBe(false)
  })
  it("external telemetry failure cannot turn a committed save into failure", async () => {
    const { client } = fixture()
    mocks.send.mockRejectedValueOnce(new Error("outage"))
    await expect(client.opportunity.update({ where: { id: "item" }, data: { title: "after" } })).resolves.toMatchObject({ title: "after" })
  })
  it("reuses the outer interview transaction and waits until its receipt commits", async () => {
    const { tx, transaction } = fixture()
    await withAnalyticsTool("update_opportunity", async () => {
      await withToolTransaction(tx as never, async () => {
        await getMcpActivityPrisma().opportunity.update({ where: { id: "item" }, data: { title: "after" } })
      })
      expect(mocks.send).not.toHaveBeenCalled()
    })
    expect(transaction).not.toHaveBeenCalled()
    expect(mocks.send).toHaveBeenCalledWith({ action: "opportunity_updated", source: "mcp" })
  })
  it("discards queued events if an interview receipt rolls back", async () => {
    const { tx } = fixture()
    await expect(withAnalyticsTool("update_opportunity", async () => {
      await withToolTransaction(tx as never, () => getMcpActivityPrisma().opportunity.update({ where: { id: "item" }, data: { title: "after" } }))
      throw new Error("receipt superseded")
    })).rejects.toThrow("receipt superseded")
    expect(mocks.send).not.toHaveBeenCalled()
  })
  it("rejects unauthorized writes before saving the product or activity", async () => {
    const { client, model, tx } = fixture()
    mocks.member.mockRejectedValueOnce(new Error("denied"))
    await expect(client.opportunity.update({ where: { id: "item" }, data: { title: "after" } })).rejects.toThrow("denied")
    expect(model.update).not.toHaveBeenCalled()
    expect(tx.workspaceActivationState.upsert).not.toHaveBeenCalled()
  })
  it("does not intercept writes from an unlisted tool such as imports or metric refresh", async () => {
    const { tx } = fixture()
    await withAnalyticsTool("refresh_metric_binding", async () => {
      await getMcpActivityPrisma().opportunity.update({ where: { id: "item" }, data: { title: "after" } })
    })
    expect(tx.workspaceActivationState.upsert).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
