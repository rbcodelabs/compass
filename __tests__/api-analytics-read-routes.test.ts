/**
 * GET /api/analytics/measurements and GET /api/analytics/metrics back the
 * measurements panel's mount-time reads. They are route handlers rather than
 * server actions on purpose: a server action in flight while the user closes a
 * detail panel commits its stale router state and reopens the panel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockGetWorkspace = vi.fn()
vi.mock("@/lib/workspace", () => ({ getWorkspace: (...args: unknown[]) => mockGetWorkspace(...args) }))

const service = vi.hoisted(() => ({ listBindings: vi.fn(), listObservations: vi.fn(), listMetrics: vi.fn() }))
vi.mock("@/lib/analytics/service", async (load) => ({ ...(await load<typeof import("@/lib/analytics/service")>()), ...service }))

import { GET as getMeasurements } from "@/app/api/analytics/measurements/route"
import { GET as getMetrics } from "@/app/api/analytics/metrics/route"

const TARGET_ID = "00000000-0000-4000-8000-000000000001"
const req = (path: string, query: Record<string, string>) => new Request(`https://compass.test/api/analytics/${path}?${new URLSearchParams(query)}`)
const scope = { orgSlug: "acme", workspaceSlug: "product" }

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockGetWorkspace.mockResolvedValue({ id: "ws-1" })
})

describe("GET /api/analytics/measurements", () => {
  it("returns 401 without a session", async () => {
    mockAuth.mockResolvedValue(null)
    const res = await getMeasurements(req("measurements", { ...scope, targetType: "ROADMAP_ITEM", targetId: TARGET_ID }))
    expect(res.status).toBe(401)
    expect(service.listBindings).not.toHaveBeenCalled()
  })

  it("returns 404 when the user is not a member of the workspace", async () => {
    mockGetWorkspace.mockResolvedValue(null)
    const res = await getMeasurements(req("measurements", { ...scope, targetType: "ROADMAP_ITEM", targetId: TARGET_ID }))
    expect(res.status).toBe(404)
    expect(mockGetWorkspace).toHaveBeenCalledWith("acme", "product", "user-1")
  })

  it("rejects an invalid target", async () => {
    const res = await getMeasurements(req("measurements", { ...scope, targetType: "OPPORTUNITY", targetId: "nope" }))
    expect(res.status).toBe(400)
  })

  it("returns each binding with its observations for a member", async () => {
    service.listBindings.mockResolvedValue([{ id: "b1" }])
    service.listObservations.mockResolvedValue([{ id: "o1" }])
    const res = await getMeasurements(req("measurements", { ...scope, targetType: "ROADMAP_ITEM", targetId: TARGET_ID }))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toContain("no-store")
    expect(await res.json()).toEqual([{ binding: { id: "b1" }, observations: [{ id: "o1" }] }])
    const actor = { userId: "user-1", purpose: "USER" }
    expect(service.listBindings).toHaveBeenCalledWith(actor, "ws-1", { targetType: "ROADMAP_ITEM", targetId: TARGET_ID })
    expect(service.listObservations).toHaveBeenCalledWith(actor, "ws-1", "b1")
  })
})

describe("GET /api/analytics/metrics", () => {
  it("returns 401 without a session", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await getMetrics(req("metrics", scope))).status).toBe(401)
  })

  it("returns 400 without a workspace scope", async () => {
    expect((await getMetrics(req("metrics", { orgSlug: "acme" }))).status).toBe(400)
  })

  it("returns the workspace metric definitions for a member", async () => {
    service.listMetrics.mockResolvedValue([{ id: "m1" }])
    const res = await getMetrics(req("metrics", scope))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([{ id: "m1" }])
    expect(service.listMetrics).toHaveBeenCalledWith({ userId: "user-1", purpose: "USER" }, "ws-1")
  })
})
