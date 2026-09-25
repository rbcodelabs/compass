/**
 * The only way this feature talks to a third party (ADR-0018).
 *
 * Two properties are non-negotiable and are the reason this is one module rather
 * than a `fetch` call at each site:
 *
 *  - **`redirect: "manual"`, and a 3xx is a hard error.** A redirect on a
 *    metadata or token endpoint moves the request to a host that none of the
 *    origin validation ever saw. On the token endpoint specifically, following
 *    one would forward the PKCE verifier and the refresh token to wherever the
 *    redirect pointed. Refusing is the only safe reading.
 *  - **A hard timeout.** Vercel's gateway cuts the response at 60 s regardless of
 *    `maxDuration`, so a hung provider must fail fast enough that the caller can
 *    still return a useful error rather than being killed mid-flight.
 *
 * Response bodies are size-capped because none of these responses is trusted
 * input, and a provider having a bad day should not be able to exhaust the
 * function's memory.
 */
import { McpConnectorError, OUTBOUND_TIMEOUT_MS, type McpConnectorErrorCode } from "@/lib/mcp-connectors/config"

/** Caps how much of a third party's response body Compass will buffer. */
export const MAX_RESPONSE_BYTES = 64 * 1024

export async function outboundFetch(
  url: URL,
  init: RequestInit,
  failureCode: McpConnectorErrorCode,
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    })
  } catch (error) {
    throw new McpConnectorError(
      failureCode,
      `${url.toString()} did not answer: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (response.status >= 300 && response.status < 400)
    throw new McpConnectorError(
      failureCode,
      `${url.toString()} redirected (${response.status}); Compass does not follow redirects on OAuth endpoints.`,
    )
  return response
}

export async function readBoundedText(
  response: Response,
  failureCode: McpConnectorErrorCode,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new McpConnectorError(failureCode, "Response body exceeded 64 KiB.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** Fetches and parses a JSON **object**. An array or a scalar is a failure. */
export async function fetchJsonObject(
  url: URL,
  init: RequestInit,
  failureCode: McpConnectorErrorCode,
): Promise<Record<string, unknown>> {
  const response = await outboundFetch(url, init, failureCode)
  const body = await readBoundedText(response, failureCode)
  if (!response.ok)
    throw new McpConnectorError(
      failureCode,
      // Provider error bodies are quoted because OAuth carries its real
      // diagnosis there (`invalid_target`, `invalid_grant`) and a bare status
      // code turns every failure into the same unhelpful line. Truncated
      // because it is untrusted text headed for a log.
      `${url.toString()} returned ${response.status}: ${body.slice(0, 300)}`,
    )
  return parseJsonObject(body, url, failureCode)
}

export function parseJsonObject(
  body: string,
  url: URL,
  failureCode: McpConnectorErrorCode,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new McpConnectorError(failureCode, `${url.toString()} did not return JSON.`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new McpConnectorError(failureCode, `${url.toString()} did not return a JSON object.`)
  return parsed as Record<string, unknown>
}

export function requireHttpsUrl(raw: string, label: string, failureCode: McpConnectorErrorCode): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new McpConnectorError(failureCode, `${label} is not an absolute URL: ${raw}`)
  }
  if (url.protocol !== "https:")
    throw new McpConnectorError(failureCode, `${label} must use HTTPS: ${raw}`)
  if (url.username || url.password)
    throw new McpConnectorError(failureCode, `${label} must not carry credentials.`)
  if (url.hash) throw new McpConnectorError(failureCode, `${label} must not carry a fragment.`)
  return url
}
