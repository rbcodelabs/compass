/**
 * MCP handlers for embedded-feedback sources (`create_feedback_source`,
 * `update_feedback_source`).
 *
 * Authorization (workspace ADMIN, same bar as the settings UI) is enforced by
 * the gates in lib/mcp-tool-gates.ts before these run; the data rules live in
 * lib/embed-source-service.ts so the UI and MCP cannot drift.
 *
 * The raw embed token is returned exactly once, in the create response. It is
 * never logged here, and the agent-activity audit (lib/agent-activity.ts) records
 * only the tool name and outcome, never arguments or results. Do not add logging
 * of either result below.
 *
 * There is deliberately no delete, token-mint or token-revoke tool: disabling a
 * source (`enabled: false`) is the off switch available to agents, and credential
 * rotation stays a human action in Settings.
 */
import getPrisma from "@/lib/db"
import { fail, ok } from "@/lib/mcp-output"
import { getMcpActor } from "@/lib/mcp-authz"
import { optionalCompassUrl, trustedCompassBaseUrl } from "@/lib/compass-url"
import { EmbedOriginError } from "@/lib/embed-sources"
import {
  EmbedSourceInputError,
  buildEmbedSnippet,
  createEmbedSource,
  updateEmbedSource,
} from "@/lib/embed-source-service"

function expectedFailure(error: unknown): string | null {
  return error instanceof EmbedOriginError || error instanceof EmbedSourceInputError ? error.message : null
}

export async function createFeedbackSourceTool(input: {
  workspaceId: string
  artifactId: string
  name: string
  allowedOrigins: string[]
  authMode?: "INTERNAL_SSO" | "PORTAL"
}) {
  try {
    const created = await createEmbedSource(
      { prisma: getPrisma(), workspaceId: input.workspaceId, userId: getMcpActor().userId },
      input
    )
    const base = optionalCompassUrl(() => trustedCompassBaseUrl().origin)
    const embed = buildEmbedSnippet(base, created.token)
    const lines = [
      "Feedback source created. The token is shown ONCE — it is stored only as a hash and cannot be retrieved again.",
      `ID: ${created.id}`,
      `Token: ${created.token}`,
      `Auth mode: ${created.authMode}`,
      `Allowed origins: ${created.allowedOrigins.join(", ")}`,
      embed.snippet
        ? `Snippet (paste into the root layout of the prototype):\n${embed.snippet}`
        : `Snippet unavailable: this Compass deployment has no public URL configured (NEXT_PUBLIC_APP_URL is unset), so the script URL cannot be built. ` +
          `Load ${embed.scriptPath} from your Compass host with data-compass-token set to the token above, e.g. ` +
          `<script src="https://<compass-host>${embed.scriptPath}" data-compass-token="${created.token}" defer></script>`,
      "Requests from any origin not listed are refused; call update_feedback_source to add the deployed origin once it is known.",
    ]
    return ok(lines.join("\n"), {
      sourceId: created.id,
      token: created.token,
      tokenPrefix: created.tokenPrefix,
      snippet: embed.snippet,
      scriptPath: embed.scriptPath,
      scriptUrl: embed.scriptUrl,
      allowedOrigins: created.allowedOrigins,
      authMode: created.authMode,
      note: embed.snippet ? null : "NEXT_PUBLIC_APP_URL is not configured; build the script URL from your Compass host + scriptPath.",
    })
  } catch (error) {
    const message = expectedFailure(error)
    if (message) return fail(message)
    throw error
  }
}

export async function updateFeedbackSourceTool(input: {
  workspaceId: string
  sourceId: string
  allowedOrigins?: string[]
  enabled?: boolean
  name?: string
  authMode?: "INTERNAL_SSO" | "PORTAL"
}) {
  try {
    const { workspaceId, sourceId, ...changes } = input
    if (Object.values(changes).every((value) => value === undefined)) {
      return fail("Provide at least one of allowedOrigins, enabled, name or authMode to update.")
    }
    const updated = await updateEmbedSource(
      { prisma: getPrisma(), workspaceId, userId: getMcpActor().userId },
      sourceId,
      changes
    )
    return ok(
      [
        "Feedback source updated.",
        `ID: ${sourceId}`,
        `Name: ${updated.name}`,
        `Enabled: ${updated.enabled}`,
        `Auth mode: ${updated.authMode}`,
        `Allowed origins: ${updated.allowedOrigins.join(", ") || "(none)"}`,
      ].join("\n"),
      { sourceId, ...updated }
    )
  } catch (error) {
    const message = expectedFailure(error)
    if (message) return fail(message)
    throw error
  }
}
