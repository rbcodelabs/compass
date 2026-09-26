/**
 * The outbound authorization-code + refresh flow (ADR-0018).
 *
 * ## `resource` is not optional here
 *
 * Compass's *own* authorization server is lenient about RFC 8707 `resource`
 * (see `lib/oauth/resource.ts` — the Geode broker never sends it). v0 is the
 * opposite: it hard-rejects a request without one with `400 invalid_target`, and
 * it wants the **same** value on all three legs — authorize, code exchange, and
 * every refresh. Sending it on the first two and forgetting it on refresh
 * produces a connector that works until the first token expiry and then fails
 * in the middle of an agent run, which is the worst available failure shape. So
 * `resource` is threaded through one place: {@link tokenRequestBody}.
 *
 * ## No proactive refresh
 *
 * There is no timer. A serverless invocation does not outlive the request that
 * created it, so a scheduled refresh either never fires or fires in a process
 * that no longer matters. Agent Threads refreshes on a timer and has a
 * documented zero-delay spin when `expires_in <= 300`; that entire class of bug
 * is absent here because refresh happens lazily, on the request that actually
 * needs a token, which is the only moment the answer matters.
 *
 * ## PKCE
 *
 * `computeS256Challenge` is imported from `lib/oauth/pkce.ts` rather than
 * recomputed. Compass is an authorization server *and* now a client; having two
 * implementations of the same hash would mean the one with a bug is whichever
 * one has fewer tests.
 */
import {
  McpConnectorError,
  REFRESH_SKEW_SECONDS,
  connectorEncryptionKey,
} from "@/lib/mcp-connectors/config"
import { fetchJsonObject, outboundFetch, requireHttpsUrl } from "@/lib/mcp-connectors/http"
import {
  findConnector,
  findGrant,
  rotateGrantTokens,
  type ConnectorRecord,
  type GrantRecord,
  type GrantTokens,
} from "@/lib/mcp-connectors/store"
import { computeS256Challenge } from "@/lib/oauth/pkce"

/**
 * The URL the user's browser is sent to.
 *
 * `code_challenge_method` is always `S256`. The RFC 7636 `plain` method is not
 * offered even as a fallback: a provider that cannot do S256 is a provider whose
 * authorization code can be replayed by anything that observed the redirect.
 */
export function buildAuthorizeUrl(
  connector: ConnectorRecord,
  input: { state: string; codeVerifier: string; redirectUri: string },
): string {
  const url = requireHttpsUrl(connector.authorizationEndpoint, "authorization_endpoint", "DISCOVERY_FAILED")
  const params = new URLSearchParams({
    response_type: "code",
    client_id: connector.clientId,
    redirect_uri: input.redirectUri,
    scope: connector.scope,
    state: input.state,
    code_challenge: computeS256Challenge(input.codeVerifier),
    code_challenge_method: "S256",
    resource: connector.resource,
  })
  // Appended rather than assigned, so a provider whose authorization endpoint
  // already carries query parameters keeps them.
  for (const [key, value] of params) url.searchParams.set(key, value)
  return url.toString()
}

/** Shared by the exchange and the refresh, so `resource` cannot be forgotten on one. */
function tokenRequestBody(connector: ConnectorRecord, fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    ...fields,
    // Public client: `client_id` in the body *is* the client authentication
    // (RFC 6749 §2.1 / §3.2.1). There is no secret to send, by design — v0
    // registers Compass with `token_endpoint_auth_method: "none"`.
    client_id: connector.clientId,
    resource: connector.resource,
  })
}

export async function exchangeAuthorizationCode(
  connector: ConnectorRecord,
  input: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GrantTokens> {
  return requestTokens(
    connector,
    tokenRequestBody(connector, {
      grant_type: "authorization_code",
      code: input.code,
      // Must byte-match the value sent to the authorization endpoint, which is
      // why it comes from the stored auth request rather than being rebuilt.
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
    "TOKEN_EXCHANGE_FAILED",
  )
}

export async function refreshTokens(
  connector: ConnectorRecord,
  refreshToken: string,
): Promise<GrantTokens> {
  return requestTokens(
    connector,
    tokenRequestBody(connector, { grant_type: "refresh_token", refresh_token: refreshToken }),
    "REFRESH_FAILED",
  )
}

async function requestTokens(
  connector: ConnectorRecord,
  body: URLSearchParams,
  failureCode: "TOKEN_EXCHANGE_FAILED" | "REFRESH_FAILED",
): Promise<GrantTokens> {
  const endpoint = requireHttpsUrl(connector.tokenEndpoint, "token_endpoint", failureCode)
  const document = await fetchJsonObject(
    endpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    failureCode,
  )

  const accessToken = document.access_token
  if (typeof accessToken !== "string" || !accessToken)
    throw new McpConnectorError(failureCode, `${endpoint.toString()} returned no access_token.`)

  const tokenType = typeof document.token_type === "string" ? document.token_type.toLowerCase() : "bearer"
  // The gateway sends `Authorization: Bearer <token>` unconditionally. A provider
  // issuing a DPoP or MAC token needs proof-of-possession machinery that does not
  // exist here, and sending it as a bearer would either fail confusingly or
  // strip a security property the provider asked for.
  if (tokenType !== "bearer")
    throw new McpConnectorError(
      failureCode,
      `${endpoint.toString()} issued a "${tokenType}" token; Compass only knows how to present bearer tokens.`,
    )

  const expiresIn = document.expires_in
  return {
    accessToken,
    refreshToken: typeof document.refresh_token === "string" && document.refresh_token ? document.refresh_token : null,
    // A provider that states no lifetime gets no expiry, and the token is used
    // until it is refused. Inventing a default would either refresh needlessly or
    // — worse — treat a still-valid token as expired and burn a refresh token on
    // a provider that rotates them.
    accessTokenExpiresAt: typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null,
    // A provider may narrow the granted scope. Record what it actually gave,
    // not what was asked for.
    scope: typeof document.scope === "string" && document.scope ? document.scope.slice(0, 255) : connector.scope,
  }
}

export interface ResolvedConnectorToken {
  connector: ConnectorRecord
  accessToken: string
}

/**
 * A usable bearer token for this user and connector, refreshing first if the
 * stored one is spent.
 *
 * Returns `null` for *not connected* — no connector row for this origin, no
 * grant, or a revoked one — because that is an ordinary state the caller renders
 * as a Connect button. It throws only when something is genuinely wrong: a
 * refresh the provider rejected, a missing encryption key, a grant changed
 * underneath an in-flight refresh.
 */
export async function resolveConnectorToken(
  slug: string,
  origin: string,
  userId: string,
): Promise<ResolvedConnectorToken | null> {
  const connector = await findConnector(slug, origin)
  if (!connector || !connector.enabled) return null
  const grant = await findGrant(connector.id, userId)
  if (!grant) return null
  if (!isExpiring(grant)) return { connector, accessToken: grant.accessToken }
  return { connector, accessToken: await refreshGrant(connector, grant) }
}

function isExpiring(grant: GrantRecord): boolean {
  if (!grant.accessTokenExpiresAt) return false
  return grant.accessTokenExpiresAt.getTime() - REFRESH_SKEW_SECONDS * 1000 <= Date.now()
}

/**
 * Refreshes and stores, yielding to whoever wrote first.
 *
 * `rotateGrantTokens` fences on the generation this grant was read at. If
 * another invocation refreshed in the meantime, our write lands on nothing and
 * the row already holds a token at least as fresh as the one we just obtained —
 * so we use theirs. Ours is discarded, which is correct rather than wasteful:
 * v0 rotates refresh tokens, so the refresh token we just received is already
 * the only live one and the winner's row holds it.
 */
export async function refreshGrant(connector: ConnectorRecord, grant: GrantRecord): Promise<string> {
  if (!grant.refreshToken)
    throw new McpConnectorError(
      "REFRESH_FAILED",
      `The ${connector.displayName} connection has expired and cannot be renewed automatically. Reconnect it.`,
    )
  // Touch the key before spending a single-use refresh token: a missing key would
  // otherwise surface *after* the provider has already rotated it away, leaving a
  // grant that can never be refreshed again.
  connectorEncryptionKey()

  const tokens = await refreshTokens(connector, grant.refreshToken)
  const stored = await rotateGrantTokens({
    grantId: grant.id,
    expectedGeneration: grant.generation,
    ...tokens,
  })
  return stored.accessToken
}

/**
 * Best-effort RFC 7009 revocation at the provider.
 *
 * Deliberately swallows failure: Compass has already dropped its copy of the
 * token by the time this runs, so the user's connection *is* gone locally, and
 * reporting an error for a provider-side courtesy call would make disconnect
 * look broken when it is not.
 */
export async function revokeAtProvider(connector: ConnectorRecord, token: string): Promise<boolean> {
  if (!connector.revocationEndpoint) return false
  try {
    const endpoint = requireHttpsUrl(connector.revocationEndpoint, "revocation_endpoint", "REFRESH_FAILED")
    const response = await outboundFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ token, client_id: connector.clientId }).toString(),
      },
      "REFRESH_FAILED",
    )
    return response.ok
  } catch {
    return false
  }
}
