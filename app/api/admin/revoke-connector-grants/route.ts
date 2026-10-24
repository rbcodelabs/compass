/**
 * POST /api/admin/revoke-connector-grants
 *
 * Incident kill-switch for outbound MCP connector grants (ADR-0018): wipes every
 * stored third-party token and asks each provider to revoke it. Use it when
 * `MCP_CONNECTOR_SECRET_ENCRYPTION_KEY` may have leaked. See
 * `lib/mcp-connectors/revoke-all.ts` for the ordering rules, and
 * docs/content/23-connected-mcp-servers.md ("Emergency revocation") for the
 * runbook — in particular, run this BEFORE rotating the key.
 *
 * Same trust boundary as `/api/admin/migrate`: the `x-migration-secret` header.
 *
 * Body (all optional): `{ "dryRun": false, "slug": "google-drive", "userId": "..." }`.
 * `dryRun` defaults to **true**; only an explicit `false` writes. The response
 * holds counts only — never a token, ciphertext, or user identifier.
 *
 * Resumable: if the response says `truncated: true`, POST the same body again.
 */
import { NextRequest, NextResponse } from "next/server"
import { revokeAllConnectorGrants } from "@/lib/mcp-connectors/revoke-all"
import { secretMatches } from "@/lib/secret-compare"

export const dynamic = "force-dynamic"
export const maxDuration = 60

function checkAuth(req: NextRequest): boolean {
  return secretMatches(req.headers.get("x-migration-secret"), process.env.MIGRATION_SECRET)
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as {
    dryRun?: unknown
    slug?: unknown
    userId?: unknown
  } | null

  const slug = optionalString(body?.slug)
  const userId = optionalString(body?.userId)
  if (slug === undefined || userId === undefined)
    return NextResponse.json({ error: "slug and userId must be non-empty strings when supplied." }, { status: 400 })

  try {
    const result = await revokeAllConnectorGrants({
      slug,
      userId,
      dryRun: body?.dryRun !== false,
    })
    return NextResponse.json(result)
  } catch (error) {
    // Deliberately generic: the message of a crypto or database error has no
    // business in a response, and the operator can re-run (the job is resumable).
    console.error("[revoke-connector-grants] failed", error)
    return NextResponse.json({ error: "Revocation failed; re-run to continue." }, { status: 500 })
  }
}

/** `null` when absent, `undefined` when present but unusable, else the trimmed string. */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || !value.trim() || value.length > 255) return undefined
  return value.trim()
}
