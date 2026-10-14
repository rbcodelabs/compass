/**
 * Customer boundary of Portal Home after the team home started showing internal
 * data: the customer-facing entry points must never run with the team audience.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createWidget } from "@/lib/portal-home/schema"

const WS = "11111111-1111-4111-8111-111111111111"
const PRIVATE_ID = "00000000-0000-4000-8000-000000000002"
const PUBLIC_ID = "00000000-0000-4000-8000-000000000001"
const rows = [
  { id: PUBLIC_ID, title: "Public now", horizon: "NOW", status: "ACTIVE", isPrivate: false, sortOrder: 1, startDate: null, endDate: null },
  { id: PRIVATE_ID, title: "SECRET private now", horizon: "NOW", status: "ACTIVE", isPrivate: true, sortOrder: 2, startDate: null, endDate: null },
]

const roadmapFindMany = vi.fn(async (args: { where: { isPrivate?: boolean; id?: { in: string[] } } }) =>
  rows.filter((row) => (args.where.isPrivate === undefined || row.isPrivate === args.where.isPrivate) && (!args.where.id || args.where.id.in.includes(row.id))),
)
const prisma = {
  workspace: { findUnique: vi.fn(async () => ({ id: WS, roadmapPublic: true, feedbackEnabled: true })) },
  roadmapItem: { findMany: roadmapFindMany },
  doc: { findMany: vi.fn(async () => []) },
}

vi.mock("@/lib/permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/permissions")>()),
  resolveWorkspaceAdmin: async () => ({ workspaceId: WS, organizationId: "o" }),
}))
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u" } }) }))
vi.mock("@/lib/db", () => ({ default: () => prisma }))

const route = { params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "main" }) }
const post = (body: unknown) => new Request("http://x", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

beforeEach(() => vi.clearAllMocks())

describe("customer resolve route", () => {
  const pinned = { ...createWidget("roadmap_spotlight", 0), config: { title: "Spot", show: "status" as const, itemIds: [PRIVATE_ID, PUBLIC_ID] } }

  it("(a) never returns a pinned private item's title or id, but does for the public one", async () => {
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/resolve/route")
    const response = await POST(post({ widgets: [pinned], audience: "customer", signedIn: false }), route)
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text).not.toContain("SECRET private")
    expect(text).not.toContain(PRIVATE_ID)
    expect(text).toContain("Public now")
    expect(text).toContain("/portal/acme/main/roadmap")
    // The query itself carried the public predicate.
    expect(roadmapFindMany.mock.calls.every(([args]) => args.where.isPrivate === false)).toBe(true)
  })

  it("the member audience (admin editor canvas) does see the private item, and says so separately from customer availability", async () => {
    const { POST } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/resolve/route")
    const body = (await (await POST(post({ widgets: [pinned], audience: "member" }), route)).json()) as {
      resolved: Record<string, unknown>
      customerAvailability: Record<string, unknown>
    }
    expect(JSON.stringify(body.resolved)).toContain("SECRET private now")
    expect(JSON.stringify(body.customerAvailability)).not.toContain("SECRET")
    expect(body.customerAvailability[pinned.id]).toEqual({ shown: true })
  })
})

describe("pin picker", () => {
  it("offers private items flagged isPrivate, and archived ones never", async () => {
    const { GET } = await import("@/app/api/portal-home/[orgSlug]/[workspaceSlug]/options/route")
    await GET(new Request("http://x"), route)
    expect(roadmapFindMany).toHaveBeenCalledTimes(1)
    const args = roadmapFindMany.mock.calls[0][0] as unknown as { where: Record<string, unknown>; select: Record<string, boolean> }
    expect(args.where).toEqual({ workspaceId: WS, status: { not: "ARCHIVED" } })
    expect(args.select.isPrivate).toBe(true)
  })
})

describe("(e) customer-facing entry points never use the team audience", () => {
  const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8")
  const portalPage = read("app/portal/[orgSlug]/[workspaceSlug]/page.tsx")
  const resolveRoute = read("app/api/portal-home/[orgSlug]/[workspaceSlug]/resolve/route.ts")

  it("the portal page builds its public board only with resolveHomeForCustomer", () => {
    expect(portalPage).toContain("resolveHomeForCustomer(")
    expect(portalPage).not.toContain("resolveHomeForTeam")
    expect(portalPage).not.toMatch(/audience:\s*["']team["']/)
    expect(portalPage).not.toMatch(/isWorkspaceMember:\s*true/)
  })

  it("the resolve route's customer branch calls resolveHomeForCustomer and never resolveHomeForTeam", () => {
    expect(resolveRoute).toContain("resolveHomeForCustomer(")
    expect(resolveRoute).not.toContain("resolveHomeForTeam")
    expect(resolveRoute).not.toMatch(/audience:\s*["']team["']/)
    expect(resolveRoute).not.toMatch(/isWorkspaceMember:\s*true/)
  })

  it("only the team entry points in resolve.ts construct a team context", () => {
    const resolve = read("lib/portal-home/resolve.ts")
    const customerFn = resolve.slice(resolve.indexOf("export async function resolveHomeForCustomer"), resolve.indexOf("export async function resolveHomeForTeam"))
    expect(customerFn).not.toMatch(/audience:\s*"team"/)
    const availabilityFn = resolve.slice(resolve.indexOf("export async function resolveCustomerAvailability"))
    expect(availabilityFn).not.toMatch(/audience:\s*"team"/)
    // No other module (page, route, widget) builds one.
    for (const file of ["app/portal/[orgSlug]/[workspaceSlug]/page.tsx", "lib/portal-home/admin-api.ts"]) {
      expect(read(file)).not.toMatch(/audience:\s*["']team["']/)
    }
  })
})
