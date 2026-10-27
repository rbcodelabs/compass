/**
 * Guard tests for the connector catalog and disconnect routes (ADR-0018):
 * `app/api/connectors` and `app/api/connectors/[slug]`.
 *
 * The disconnect route's whole content is an ordering: read the tokens, drop
 * Compass's copy, *then* tell the provider. Both halves of that are tested here,
 * because the reverse order fails in the way that matters — a provider timeout
 * would leave a usable token in the database while telling the user the disconnect
 * failed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import { McpConnectorError } from "@/lib/mcp-connectors/config"
import { connectMocks, resetConnectMocks, UserAuthorizationRequiredError } from "./helpers/mock-vercel-connect"

vi.mock("@vercel/connect", async () => (await import("./helpers/mock-vercel-connect")).connectModule())

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockAvailable = vi.fn()
const mockFindConnector = vi.fn()
const mockFindGrant = vi.fn()
const mockDisconnectGrant = vi.fn()
const mockListConnectedGrants = vi.fn()
vi.mock("@/lib/mcp-connectors/store", () => ({
  mcpConnectorsAvailable: () => mockAvailable(),
  findConnector: (...args: unknown[]) => mockFindConnector(...args),
  findGrant: (...args: unknown[]) => mockFindGrant(...args),
  disconnectGrant: (...args: unknown[]) => mockDisconnectGrant(...args),
  listConnectedGrants: (...args: unknown[]) => mockListConnectedGrants(...args),
}))

const mockRevokeAtProvider = vi.fn()
vi.mock("@/lib/mcp-connectors/tokens", () => ({
  revokeAtProvider: (...args: unknown[]) => mockRevokeAtProvider(...args),
}))

const { resetConnectLevelMemo: resetLevelMemo } = await import("@/lib/mcp-connectors/vercel-connect")
const { GET: listConnectors } = await import("@/app/api/connectors/route")
const { DELETE: disconnect } = await import("@/app/api/connectors/[slug]/route")

const connector = { id: "connector-1", slug: "v0", displayName: "v0", revocationEndpoint: "https://v0.app/oauth/revoke" }
const params = (slug = "v0") => ({ params: Promise.resolve({ slug }) })
const request = () => new Request("http://localhost:3000/api/connectors/v0", { method: "DELETE" })

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockAvailable.mockResolvedValue(true)
  mockFindConnector.mockResolvedValue(connector)
  mockFindGrant.mockResolvedValue({ accessToken: "at", refreshToken: "rt", generation: 1 })
  mockDisconnectGrant.mockResolvedValue(true)
  mockRevokeAtProvider.mockResolvedValue(true)
  mockListConnectedGrants.mockResolvedValue([])
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.unstubAllEnvs()
  resetConnectMocks()
  // Drive is Connect-backed: the connector UID is what makes it configured.
  vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "google/compass")
  // Not consented at any level unless a test says otherwise.
  connectMocks.getToken.mockRejectedValue(new UserAuthorizationRequiredError("consent required"))
  resetLevelMemo()
})

describe("GET /api/connectors", () => {
  it("reports the catalog with this user's connection state, scoped to this origin", async () => {
    mockListConnectedGrants.mockResolvedValue([{ slug: "v0", scope: "mcp" }])
    const response = await listConnectors()
    const body = await response.json()

    expect(body.available).toBe(true)
    expect(body.connectors).toEqual([
      expect.objectContaining({ slug: "v0", connected: true, serverUrl: "https://v0.app/api/mcp", configured: true }),
      expect.objectContaining({ slug: "vercel", connected: false, serverUrl: "https://mcp.vercel.com" }),
      expect.objectContaining({ slug: "google-drive", connected: false }),
    ])
    // A preview deployment must not report a production grant: that registration
    // has a different client_id and redirect_uri entirely.
    expect(mockListConnectedGrants).toHaveBeenCalledWith("user-1", "http://localhost:3000", undefined)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("reports the access choice, and the level a connected grant actually holds", async () => {
    // Connect has a grant only at the read-only scope.
    connectMocks.getToken.mockImplementation(async (_uid: string, params: { scopes: string[] }) => {
      if (params.scopes.join(" ") === "https://www.googleapis.com/auth/drive.readonly") return "ro-token"
      throw new UserAuthorizationRequiredError("consent required")
    })
    const body = await (await listConnectors()).json()
    const drive = body.connectors.find((c: { slug: string }) => c.slug === "google-drive")
    expect(drive.accessLevels.map((level: { id: string }) => level.id)).toEqual(["full", "read-only"])
    expect(drive.defaultAccessLevel).toBe("full")
    expect(drive.accessLevel).toBe("read-only")
    // Nothing the client doesn't need: the scopes and guidance stay server-side.
    expect(JSON.stringify(drive)).not.toContain("googleapis.com/auth")

    const v0 = body.connectors.find((c: { slug: string }) => c.slug === "v0")
    expect(v0.accessLevels).toEqual([])
    expect(v0.defaultAccessLevel).toBeNull()
    expect(v0.accessLevel).toBeNull()
  })

  it("flags a Connect-backed connector as unconfigured until its connector UID exists, and never leaks it", async () => {
    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "")
    const unconfigured = await (await listConnectors()).json()
    const drive = (body: typeof unconfigured) => body.connectors.find((c: { slug: string }) => c.slug === "google-drive")
    expect(drive(unconfigured).configured).toBe(false)
    expect(drive(unconfigured).connected).toBe(false)
    // Unconfigured means no Connect call at all.
    expect(connectMocks.getToken).not.toHaveBeenCalled()
    // A DCR connector is always startable.
    expect(unconfigured.connectors.find((c: { slug: string }) => c.slug === "v0").configured).toBe(true)

    vi.stubEnv("COMPASS_GOOGLE_CONNECTOR", "google/secret-uid-value")
    const text = await (await listConnectors()).text()
    expect(drive(JSON.parse(text)).configured).toBe(true)
    expect(text).not.toContain("secret-uid-value")
  })

  it("shows Drive as connected from a Connect token, and ignores a stale stored grant", async () => {
    connectMocks.getToken.mockResolvedValue("full-token")
    // A grant row from before the move to Connect must not count.
    mockListConnectedGrants.mockResolvedValue([{ slug: "google-drive", scope: "https://www.googleapis.com/auth/drive.readonly" }])
    const body = await (await listConnectors()).json()
    const drive = body.connectors.find((c: { slug: string }) => c.slug === "google-drive")
    expect(drive.connected).toBe(true)
    expect(drive.accessLevel).toBe("full")
    expect(connectMocks.getToken).toHaveBeenCalledWith(
      "google/compass",
      expect.objectContaining({ subject: { type: "user", id: "user-1" } }),
      undefined,
    )
  })

  it("renders the catalog as not-connected when the migration is unapplied", async () => {
    mockAvailable.mockResolvedValue(false)
    const body = await (await listConnectors()).json()
    expect(body.available).toBe(false)
    expect(body.connectors.every((item: { connected: boolean }) => !item.connected)).toBe(true)
    // Not even attempted: `available` is the signal, so there is no query to make.
    expect(mockListConnectedGrants).not.toHaveBeenCalled()
  })

  it("401s a signed-out caller", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await listConnectors()).status).toBe(401)
  })
})

describe("DELETE /api/connectors/[slug]", () => {
  it("drops Compass's copy before telling the provider", async () => {
    const order: string[] = []
    mockFindGrant.mockImplementation(async () => {
      order.push("read")
      return { accessToken: "at", refreshToken: "rt" }
    })
    mockDisconnectGrant.mockImplementation(async () => {
      order.push("drop")
      return true
    })
    mockRevokeAtProvider.mockImplementation(async () => {
      order.push("revoke")
      return true
    })

    const body = await (await disconnect(request(), params())).json()

    expect(body).toEqual({ disconnected: true, revokedAtProvider: true })
    // Read before drop, because `disconnectGrant` blanks both ciphertexts and a
    // dropped token cannot be revoked. Drop before revoke, so a provider timeout
    // cannot leave a live token in the database.
    expect(order).toEqual(["read", "drop", "revoke"])
    // The refresh token is preferred: revoking it kills the whole grant at most
    // providers, while revoking an access token leaves the refresh able to mint
    // another one.
    expect(mockRevokeAtProvider).toHaveBeenCalledWith(connector, "rt")
  })

  it("falls back to the access token when there is no refresh token", async () => {
    mockFindGrant.mockResolvedValue({ accessToken: "at", refreshToken: null })
    await disconnect(request(), params())
    expect(mockRevokeAtProvider).toHaveBeenCalledWith(connector, "at")
  })

  it("still disconnects when the provider refuses the revocation", async () => {
    mockRevokeAtProvider.mockResolvedValue(false)
    const body = await (await disconnect(request(), params())).json()
    // Reported rather than hidden: Compass no longer holds a token, but the user
    // may want to revoke Compass at the provider themselves.
    expect(body).toEqual({ disconnected: true, revokedAtProvider: false })
  })

  it("still disconnects when the stored tokens cannot be decrypted", async () => {
    // A rotated or missing encryption key must not trap a user in a connection
    // they have asked to leave.
    mockFindGrant.mockRejectedValue(new McpConnectorError("ENCRYPTION_NOT_CONFIGURED"))
    const body = await (await disconnect(request(), params())).json()
    expect(body).toEqual({ disconnected: true, revokedAtProvider: false })
    expect(mockDisconnectGrant).toHaveBeenCalled()
    expect(mockRevokeAtProvider).not.toHaveBeenCalled()
  })

  it("is idempotent when there is nothing connected", async () => {
    mockFindGrant.mockResolvedValue(null)
    mockDisconnectGrant.mockResolvedValue(false)
    const body = await (await disconnect(request(), params())).json()
    expect(body).toEqual({ disconnected: false, revokedAtProvider: false })
    expect(mockRevokeAtProvider).not.toHaveBeenCalled()
  })

  it("reports success-shaped nothing when the connector row or migration is absent", async () => {
    mockFindConnector.mockResolvedValue(null)
    expect(await (await disconnect(request(), params())).json()).toEqual({
      disconnected: false,
      revokedAtProvider: false,
    })

    mockAvailable.mockResolvedValue(false)
    expect(await (await disconnect(request(), params())).json()).toEqual({
      disconnected: false,
      revokedAtProvider: false,
    })
  })

  it("401s a signed-out caller and 404s an unknown connector", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await disconnect(request(), params())).status).toBe(401)

    mockAuth.mockResolvedValue({ user: { id: "user-1" } })
    expect((await disconnect(request(), params("nope"))).status).toBe(404)
    // No user's grant is touched on either path.
    expect(mockDisconnectGrant).not.toHaveBeenCalled()
  })

  it("disconnects the caller's own grant, never one named in the request", async () => {
    await disconnect(request(), params())
    expect(mockDisconnectGrant).toHaveBeenCalledWith(connector.id, "user-1")
  })
})

describe("DELETE /api/connectors/[slug] — Vercel Connect-backed", () => {
  it("revokes at Connect for the session user and never reads stored grants", async () => {
    const response = await disconnect(request(), params("google-drive"))
    expect(await response.json()).toEqual({ disconnected: true, revokedAtProvider: true })
    expect(connectMocks.revokeToken).toHaveBeenCalledWith("google/compass", { subject: { type: "user", id: "user-1" } })
    expect(mockFindGrant).not.toHaveBeenCalled()
    expect(mockDisconnectGrant).not.toHaveBeenCalled()
  })

  it("503s with the operator-facing code when Connect is not linked", async () => {
    const { ConnectError } = await import("./helpers/mock-vercel-connect")
    connectMocks.revokeToken.mockRejectedValue(new ConnectError("not linked", { code: "client_not_linked", status: 403 }))
    const response = await disconnect(request(), params("google-drive"))
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe("CONNECT_MISCONFIGURED")
  })
})
