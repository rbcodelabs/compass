import { NextRequest } from "next/server"
import { afterEach, expect, test, vi } from "vitest"
import { proxy } from "@/proxy"
import { GET } from "@/app/api/cron/import-asset-cleanup/route"
import { sweepAbandonedAssets } from "@/lib/workspace-export/abandoned-assets"

vi.mock("@/auth", () => ({ auth: (callback: unknown) => callback }))
vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/workspace-export/abandoned-assets", () => ({
  sweepAbandonedAssets: vi.fn(async () => ({ cleaned: 0 })),
}))

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

const cleanup = "/api/cron/import-asset-cleanup"
async function dispatch(path: string, bearer?: string) {
  const req = new NextRequest(new URL(path, "https://fixture.invalid"), {
    headers: bearer ? { authorization: "Bearer " + bearer } : {},
  })
  const guard = proxy as unknown as (request: NextRequest) => Response | undefined
  return guard(req) ?? GET(req)
}

test.each([[undefined, 401], ["wrong", 401], ["fixture-secret", 200]] as const)(
  "cleanup routes bearer %s through its own authentication", async (bearer, status) => {
    vi.stubEnv("CRON_SECRET", "fixture-secret")
    vi.stubEnv("MIGRATION_SECRET", "")
    expect((await dispatch(cleanup, bearer)).status).toBe(status)
    expect(sweepAbandonedAssets).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
  },
)

test.each([cleanup + "/other", "/api/cron/unlisted", "/settings"])(
  "a cron bearer does not bypass session authentication on %s", async path => {
    const response = await dispatch(path, "fixture-secret")
    expect(response.status).toBe(302)
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login")
    expect(sweepAbandonedAssets).not.toHaveBeenCalled()
  },
)
