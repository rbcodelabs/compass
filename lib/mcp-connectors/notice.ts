/**
 * The query-string contract between the connector callback and the settings page
 * (ADR-0018).
 *
 * Both halves live here because they drifted the first time they didn't: the
 * callback wrote `connectorError` while the page read `error`, so every failure
 * redirect landed on a page that rendered no message at all — the single worst
 * outcome for this flow, since the whole point of redirecting instead of
 * returning JSON is that a human gets told what happened.
 *
 * `connectorError` rather than a bare `error` is the right name to keep:
 * `/settings/agents` is a general page that may carry an `error` param for
 * unrelated reasons, and a connector failure must not be able to impersonate one
 * (or be impersonated by one).
 */
import { CONNECTOR_DEFINITIONS } from "@/lib/mcp-connectors/config"

export const CONNECTOR_PARAM = "connector"
export const CONNECTOR_CONNECTED_PARAM = "connected"
export const CONNECTOR_ERROR_PARAM = "connectorError"

export interface ConnectorNotice {
  slug: string
  connected: boolean
  error: string | null
}

/**
 * Error codes are clamped to the OAuth charset before they are rendered.
 *
 * The callback already sanitizes a provider-supplied code on the way out, but
 * these values arrive in a URL that a third party sent the browser to, so the
 * read side validates independently rather than trusting that the producer was
 * the producer.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function readConnectorNotice(
  params: Record<string, string | string[] | undefined>,
): ConnectorNotice | null {
  const slug = typeof params[CONNECTOR_PARAM] === "string" ? params[CONNECTOR_PARAM] : null
  // An unrecognised slug yields no notice at all: rendering "«whatever» connected"
  // for a connector that does not exist would let a crafted link put arbitrary
  // text on the page.
  if (!slug || !CONNECTOR_DEFINITIONS.some(definition => definition.slug === slug)) return null
  const raw = params[CONNECTOR_ERROR_PARAM]
  const error = typeof raw === "string" && ERROR_CODE_PATTERN.test(raw) ? raw : null
  // `connected` is only honoured in the absence of an error, so a link carrying
  // both cannot render a success message over a failure.
  return { slug, connected: params[CONNECTOR_CONNECTED_PARAM] === "1" && !error, error }
}
