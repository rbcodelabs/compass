/**
 * Shared stand-in for `@vercel/connect`. Real Connect needs Vercel OIDC and a
 * linked connector, so unit tests exercise Compass's mapping around the SDK and
 * leave real behaviour to a preview deployment.
 *
 * Use from a test file as:
 *   vi.mock("@vercel/connect", async () => (await import("./helpers/mock-vercel-connect")).connectModule())
 */
import { vi } from "vitest"

export class ConnectError extends Error {
  readonly code?: string
  readonly status?: number
  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message)
    this.code = options.code
    this.status = options.status
  }
}
export class NoValidTokenError extends ConnectError {}
export class UserAuthorizationRequiredError extends ConnectError {}

export const connectMocks = {
  getToken: vi.fn(),
  revokeToken: vi.fn(),
  startAuthorization: vi.fn(),
}

export function connectModule() {
  return { ConnectError, NoValidTokenError, UserAuthorizationRequiredError, ...connectMocks }
}

/** Default: the user has consented at every level (Connect returns a token). */
export function resetConnectMocks(): void {
  connectMocks.getToken.mockReset().mockResolvedValue("connect-token")
  connectMocks.revokeToken.mockReset().mockResolvedValue(undefined)
  connectMocks.startAuthorization.mockReset().mockResolvedValue({ url: "https://connect.vercel.com/consent?x=1" })
}
