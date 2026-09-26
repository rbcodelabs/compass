/**
 * RFC 8707 resource indicators — **leniently**, which is a deliberate departure
 * from the MCP spec's client-side MUST.
 *
 * The spec says clients MUST send `resource`. The Geode broker never does, at
 * authorize or at token exchange, and neither does `mcp-remote`. An
 * authorization server that *rejects* on its absence therefore breaks its own
 * primary consumer on day one, so the rule here is:
 *
 *   absent            → default the audience to the canonical MCP resource URI
 *   present, matching → use it
 *   present, other    → reject
 *
 * This gives up nothing. `resource` exists to let an AS disambiguate which of
 * several resources a token is for; Compass's AS serves exactly one, so there
 * is nothing to disambiguate and the default is unambiguous. The audience is
 * still bound onto the token and still enforced on every request by the
 * resource server, which is where the spec's actual security property lives.
 */
import { mcpResourceUri } from "@/lib/oauth/constants"

export type ResourceResolution =
  | { ok: true; resource: string }
  | { ok: false; error: "invalid_target"; description: string }

/**
 * RFC 8707 §2 requires an absolute URI with no fragment. Beyond that this
 * normalises only what cannot change identity — a fragment is stripped rather
 * than rejected outright is *not* done here (a fragment is an outright error),
 * and a single trailing slash is tolerated because `https://host/api/mcp/` and
 * `https://host/api/mcp` address the same endpoint and clients differ on which
 * they echo back from the PRM document.
 */
export function resolveResource(raw: string | null | undefined): ResourceResolution {
  const canonical = mcpResourceUri()
  if (raw === null || raw === undefined || raw === "") return { ok: true, resource: canonical }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return {
      ok: false,
      error: "invalid_target",
      description: "resource must be an absolute URI.",
    }
  }
  if (url.hash) {
    return {
      ok: false,
      error: "invalid_target",
      description: "resource must not contain a fragment.",
    }
  }

  if (normalize(raw) !== normalize(canonical)) {
    // The canonical URI is echoed back because it is not a secret — it is
    // published in the protected-resource metadata document — and telling the
    // client the one audience this server will mint is what lets it retry
    // successfully instead of guessing.
    return {
      ok: false,
      error: "invalid_target",
      description: `This authorization server only issues tokens for ${canonical}.`,
    }
  }
  return { ok: true, resource: canonical }
}

/** Drops a single trailing slash. Nothing else is touched. */
function normalize(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}
