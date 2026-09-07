import { beforeEach, describe, expect, it, vi } from "vitest"

const authMock = vi.fn()
const getUserWorkspacesMock = vi.fn()

vi.mock("@/auth", () => ({ auth: authMock }))
vi.mock("@/lib/workspace", () => ({ getUserWorkspaces: getUserWorkspacesMock }))
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return { ...actual, cache: <T extends (...args: never[]) => unknown>(fn: T) => fn }
})

describe("getMarketingViewer", () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([null, { user: {} }, { user: { email: "partial@example.com" } }])(
    "treats a missing user id as signed out",
    async (session) => {
      authMock.mockResolvedValue(session)
      const { getMarketingViewer } = await import("@/lib/marketing-viewer")

      await expect(getMarketingViewer()).resolves.toEqual({ kind: "signed-out" })
      expect(getUserWorkspacesMock).not.toHaveBeenCalled()
    }
  )

  it("returns the setup state for an authenticated user without memberships", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", name: "Rick Bowman", email: "rick@example.com", image: null } })
    getUserWorkspacesMock.mockResolvedValue([])
    const { getMarketingViewer } = await import("@/lib/marketing-viewer")

    await expect(getMarketingViewer()).resolves.toMatchObject({
      kind: "no-workspaces",
      user: { name: "Rick Bowman", email: "rick@example.com", image: null },
      workspaces: [],
    })
  })

  it("distinguishes a single workspace from multiple workspaces", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1", name: null, email: "rick@example.com", image: "https://example.com/rick.png" } })
    getUserWorkspacesMock.mockResolvedValue([
      { id: "ws-1", name: "Compass", slug: "compass", orgSlug: "rbcodelabs", orgName: "RB Code Labs" },
    ])
    const { getMarketingViewer } = await import("@/lib/marketing-viewer")

    await expect(getMarketingViewer()).resolves.toMatchObject({ kind: "single-workspace" })

    getUserWorkspacesMock.mockResolvedValue([
      { id: "ws-1", name: "Compass", slug: "compass", orgSlug: "rbcodelabs", orgName: "RB Code Labs" },
      { id: "ws-2", name: "Compass", slug: "compass", orgSlug: "acme", orgName: "Acme" },
    ])
    await expect(getMarketingViewer()).resolves.toMatchObject({ kind: "multiple-workspaces" })
  })
})
