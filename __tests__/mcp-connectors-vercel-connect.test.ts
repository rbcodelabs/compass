/**
 * Token source for Vercel Connect-backed connectors (Google Drive).
 * `@vercel/connect` is mocked: real behaviour is verified on a preview.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ConnectError,
  NoValidTokenError,
  UserAuthorizationRequiredError,
  connectMocks,
  resetConnectMocks,
} from "./helpers/mock-vercel-connect"

vi.mock("@vercel/connect", async () => (await import("./helpers/mock-vercel-connect")).connectModule())
vi.mock("@/lib/db", () => ({ default: () => ({}) }))

const mockListConnectedGrants = vi.fn()
const mockFindGrant = vi.fn()
vi.mock("@/lib/mcp-connectors/store", () => ({
  listConnectedGrants: (...args: unknown[]) => mockListConnectedGrants(...args),
  findGrant: (...args: unknown[]) => mockFindGrant(...args),
  findConnector: vi.fn().mockResolvedValue(null),
  rotateGrantTokens: vi.fn(),
}))

const { connectorDefinition, isConnectorConfigured, McpConnectorError } = await import("@/lib/mcp-connectors/config")
const { getConnectAccess, listConnections, resetConnectLevelMemo, revokeConnectGrant } = await import(
  "@/lib/mcp-connectors/vercel-connect"
)
const { refreshConnectorToken, resolveConnectorToken } = await import("@/lib/mcp-connectors/tokens")

const drive = connectorDefinition("google-drive")!
const v0 = connectorDefinition("v0")!
const FULL = "https://www.googleapis.com/auth/drive"
const READ = "https://www.googleapis.com/auth/drive.readonly"
const ORIGIN = "https://compass.example"

beforeEach(() => {
  resetConnectMocks()
  resetConnectLevelMemo()
  mockListConnectedGrants.mockReset().mockResolvedValue([])
  mockFindGrant.mockReset()
  vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "google/compass")
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => vi.unstubAllEnvs())

describe("configuration", () => {
  it("Drive is Connect-backed and v0 stays on the DCR path", () => {
    expect(drive.tokenSource).toEqual({ kind: "vercel-connect", uidEnv: "COMPASS_GOOGLE_CONNECTOR" })
    expect(drive.staticClient).toBeUndefined()
    expect(v0.tokenSource).toBeUndefined()
  })

  it("is 'Not configured' exactly when the connector UID env var is unset or blank", () => {
    expect(isConnectorConfigured(drive)).toBe(true)
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "   ")
    expect(isConnectorConfigured(drive)).toBe(false)
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "")
    expect(isConnectorConfigured(drive)).toBe(false)
    expect(isConnectorConfigured(v0)).toBe(true)
  })

  it("does not fall back to the legacy GOOGLE_CLIENT_* variables", () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "")
    vi.stubEnv("GOOGLE_CLIENT_ID", "id")
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret")
    expect(isConnectorConfigured(drive)).toBe(false)
  })
})

describe("getConnectAccess", () => {
  it("asks Connect for the session user's token at the widest level first", async () => {
    const access = await getConnectAccess(drive, "user-1")
    expect(access).toEqual({ accessToken: "connect-token", scope: FULL, levelId: "full" })
    expect(connectMocks.getToken).toHaveBeenCalledTimes(1)
    expect(connectMocks.getToken).toHaveBeenCalledWith(
      "google/compass",
      { subject: { type: "user", id: "user-1" }, scopes: [FULL] },
      undefined,
    )
  })

  it("falls through to read-only when only that was consented, and remembers it", async () => {
    connectMocks.getToken.mockImplementation(async (_uid: string, params: { scopes: string[] }) => {
      if (params.scopes[0] === READ) return "ro-token"
      throw new UserAuthorizationRequiredError("consent required")
    })
    expect(await getConnectAccess(drive, "user-1")).toEqual({ accessToken: "ro-token", scope: READ, levelId: "read-only" })
    expect(connectMocks.getToken).toHaveBeenCalledTimes(2)

    connectMocks.getToken.mockClear()
    await getConnectAccess(drive, "user-1")
    // The remembered level is tried first: one token request, not two.
    expect(connectMocks.getToken).toHaveBeenCalledTimes(1)
    expect(connectMocks.getToken.mock.calls[0][1].scopes).toEqual([READ])
  })

  it.each([
    ["UserAuthorizationRequiredError", new UserAuthorizationRequiredError("x")],
    ["NoValidTokenError", new NoValidTokenError("x")],
  ])("maps %s to 'not connected' (null)", async (_name, error) => {
    connectMocks.getToken.mockRejectedValue(error)
    expect(await getConnectAccess(drive, "user-1")).toBeNull()
  })

  it("passes forceRefresh through to the SDK", async () => {
    await getConnectAccess(drive, "user-1", { forceRefresh: true })
    expect(connectMocks.getToken.mock.calls[0][2]).toEqual({ forceRefresh: true })
  })

  it("maps project/environment link failures to CONNECT_MISCONFIGURED", async () => {
    connectMocks.getToken.mockRejectedValue(new ConnectError("Client is not linked to this project", { code: "client_not_linked", status: 403 }))
    await expect(getConnectAccess(drive, "user-1")).rejects.toMatchObject({ code: "CONNECT_MISCONFIGURED" })
    connectMocks.getToken.mockRejectedValue(new ConnectError("not enabled for environment", { code: "x" }))
    await expect(getConnectAccess(drive, "user-1")).rejects.toMatchObject({ code: "CONNECT_MISCONFIGURED" })
  })

  it("maps other Connect failures to GATEWAY_FAILED", async () => {
    connectMocks.getToken.mockRejectedValue(new ConnectError("boom", { status: 500 }))
    await expect(getConnectAccess(drive, "user-1")).rejects.toMatchObject({ code: "GATEWAY_FAILED" })
  })

  it("throws CLIENT_NOT_CONFIGURED without calling Connect when the UID is unset", async () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "")
    await expect(getConnectAccess(drive, "user-1")).rejects.toMatchObject({ code: "CLIENT_NOT_CONFIGURED" })
    expect(connectMocks.getToken).not.toHaveBeenCalled()
  })

  it("refuses a connector that is not Connect-backed", async () => {
    await expect(getConnectAccess(v0, "user-1")).rejects.toBeInstanceOf(McpConnectorError)
  })
})

describe("resolveConnectorToken / refreshConnectorToken", () => {
  it("resolves Drive from Connect without touching stored grants", async () => {
    const resolved = await resolveConnectorToken("google-drive", ORIGIN, "user-1")
    expect(resolved?.accessToken).toBe("connect-token")
    expect(resolved?.connector.serverUrl).toBe("https://drivemcp.googleapis.com/mcp/v1")
    expect(mockFindGrant).not.toHaveBeenCalled()
  })

  it("returns null (not connected) when Connect has no grant", async () => {
    connectMocks.getToken.mockRejectedValue(new UserAuthorizationRequiredError("x"))
    expect(await resolveConnectorToken("google-drive", ORIGIN, "user-1")).toBeNull()
  })

  it("a provider 401 retries with forceRefresh instead of rotating a stored grant", async () => {
    const resolved = (await resolveConnectorToken("google-drive", ORIGIN, "user-1"))!
    connectMocks.getToken.mockClear().mockResolvedValue("fresh-token")
    expect(await refreshConnectorToken(resolved, "user-1")).toBe("fresh-token")
    expect(connectMocks.getToken.mock.calls[0][2]).toEqual({ forceRefresh: true })
    expect(mockFindGrant).not.toHaveBeenCalled()
  })

  it("refresh reports a vanished Connect grant as null", async () => {
    const resolved = (await resolveConnectorToken("google-drive", ORIGIN, "user-1"))!
    connectMocks.getToken.mockRejectedValue(new NoValidTokenError("gone"))
    expect(await refreshConnectorToken(resolved, "user-1")).toBeNull()
  })
})

describe("revokeConnectGrant", () => {
  it("revokes the session user's grant at Connect", async () => {
    expect(await revokeConnectGrant(drive, "user-1")).toBe(true)
    expect(connectMocks.revokeToken).toHaveBeenCalledWith("google/compass", { subject: { type: "user", id: "user-1" } })
  })

  it("treats 'nothing to revoke' as not disconnected rather than an error", async () => {
    connectMocks.revokeToken.mockRejectedValue(new NoValidTokenError("none"))
    expect(await revokeConnectGrant(drive, "user-1")).toBe(false)
  })
})

describe("listConnections", () => {
  it("merges stored DCR grants with Connect probes and drops stale stored Drive rows", async () => {
    mockListConnectedGrants.mockResolvedValue([
      { slug: "google-drive", scope: FULL },
      { slug: "v0", scope: "mcp" },
    ])
    connectMocks.getToken.mockRejectedValue(new UserAuthorizationRequiredError("x"))
    expect(await listConnections("user-1", ORIGIN)).toEqual([{ slug: "v0", scope: "mcp" }])

    connectMocks.getToken.mockResolvedValue("t")
    expect(await listConnections("user-1", ORIGIN)).toEqual([
      { slug: "google-drive", scope: FULL },
      { slug: "v0", scope: "mcp" },
    ])
  })

  it("does not probe Connect when the connector is unconfigured", async () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "")
    await listConnections("user-1", ORIGIN)
    expect(connectMocks.getToken).not.toHaveBeenCalled()
  })

  it("degrades an operator-side Connect failure to not connected instead of failing the page or turn", async () => {
    connectMocks.getToken.mockRejectedValue(new ConnectError("not linked", { code: "client_not_linked", status: 403 }))
    expect(await listConnections("user-1", ORIGIN)).toEqual([])
  })
})
