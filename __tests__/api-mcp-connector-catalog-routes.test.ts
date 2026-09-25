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

const mockAuth = vi.fn()
vi.mock("@/auth", () => ({ auth: () => mockAuth() }))

const mockAvailable = vi.fn()
const mockFindConnector = vi.fn()
const mockFindGrant = vi.fn()
const mockDisconnectGrant = vi.fn()
const mockListConnectedSlugs = vi.fn()
vi.mock("@/lib/mcp-connectors/store", () => ({
  mcpConnectorsAvailable: () => mockAvailable(),
  findConnector: (...args: unknown[]) => mockFindConnector(...args),
  findGrant: (...args: unknown[]) => mockFindGrant(...args),
  disconnectGrant: (...args: unknown[]) => mockDisconnectGrant(...args),
  listConnectedSlugs: (...args: unknown[]) => mockListConnectedSlugs(...args),
}))

const mockRevokeAtProvider = vi.fn()
vi.mock("@/lib/mcp-connectors/tokens", () => ({
  revokeAtProvider: (...args: unknown[]) => mockRevokeAtProvider(...args),
}))

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
  mockListConnectedSlugs.mockResolvedValue([])
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("GET /api/connectors", () => {
  it("reports the catalog with this user's connection state, scoped to this origin", async () => {
    mockListConnectedSlugs.mockResolvedValue(["v0"])
    const response = await listConnectors()
    const body = await response.json()

    expect(body.available).toBe(true)
    expect(body.connectors).toEqual([
      expect.objectContaining({ slug: "v0", connected: true, serverUrl: "https://v0.app/api/mcp" }),
    ])
    // A preview deployment must not report a production grant: that registration
    // has a different client_id and redirect_uri entirely.
    expect(mockListConnectedSlugs).toHaveBeenCalledWith("user-1", "http://localhost:3000")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("renders the catalog as not-connected when the migration is unapplied", async () => {
    mockAvailable.mockResolvedValue(false)
    const body = await (await listConnectors()).json()
    expect(body.available).toBe(false)
    expect(body.connectors.every((item: { connected: boolean }) => !item.connected)).toBe(true)
    // Not even attempted: `available` is the signal, so there is no query to make.
    expect(mockListConnectedSlugs).not.toHaveBeenCalled()
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
