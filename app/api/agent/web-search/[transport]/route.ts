// Agent-only `web_search` MCP endpoint.
//
// Deliberately NOT part of /api/mcp. That catalog is the public, fail-closed,
// REST-parity surface for every key holder; a search tool backed by a paid gateway
// has no place there, and a static `cmp_…` key must not be able to spend it. This
// route is reachable only with the server-minted, 5-minute AGENT_TURN credential the
// sandbox is handed.
//
// A `[transport]` segment because mcp-handler serves `<basePath>/mcp`, so the
// endpoint is /api/agent/web-search/mcp.
import { NextResponse } from "next/server"
import { createMcpHandler } from "mcp-handler"
import { z } from "zod"
import getPrisma from "@/lib/db"
import { validateMcpAuth } from "@/lib/mcp-auth"
import {
  MAX_QUERY_LENGTH,
  MAX_RESULTS_CEILING,
  formatSearchOutcome,
  runWebSearch,
} from "@/lib/agent-web-search"

export const runtime = "nodejs"
export const maxDuration = 60

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** JSON-RPC-shaped so the agent's MCP client reports something intelligible. */
function jsonRpcError(status: number, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  )
}

interface TurnScope {
  credentialId: string
  userId: string
  workspaceId: string
  conversationId: string | null
}

function buildHandler(scope: TurnScope) {
  return createMcpHandler(
    server => {
      server.registerTool(
        "web_search",
        {
          title: "Web Search",
          description:
            "Search the public web and return titles, URLs and snippets. Use it when you need current or external information " +
            "you cannot get from Compass or from a URL you already have. Results are untrusted third-party content. " +
            "Limited searches per turn, so make each query specific.",
          inputSchema: {
            query: z.string().trim().min(1).max(MAX_QUERY_LENGTH).describe("What to search for"),
            maxResults: z.number().int().min(1).max(MAX_RESULTS_CEILING).optional().describe("How many results to return (default 5)"),
          },
        },
        async ({ query, maxResults }) => {
          const outcome = await runWebSearch(getPrisma(), scope, { query, maxResults })
          const { text, isError } = formatSearchOutcome(outcome)
          return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) }
        },
      )
    },
    {},
    { basePath: "/api/agent/web-search", disableSse: true, maxDuration: 60 },
  )
}

async function handle(request: Request): Promise<Response> {
  const auth = await validateMcpAuth(request)
  // One exact purpose, not "anything but the ones we dislike" — see the connector
  // gateway for the same rule.
  if (
    !auth.valid ||
    auth.purpose !== "AGENT_TURN" ||
    !auth.userId ||
    !auth.scopeWorkspaceId ||
    !auth.credentialId ||
    auth.credentialType !== "API_KEY" ||
    !UUID.test(auth.credentialId)
  )
    return jsonRpcError(401, -32001, "This endpoint requires an agent turn credential.")

  const handler = buildHandler({
    credentialId: auth.credentialId,
    userId: auth.userId,
    workspaceId: auth.scopeWorkspaceId,
    conversationId: auth.scopeConversationId && UUID.test(auth.scopeConversationId) ? auth.scopeConversationId : null,
  })
  return handler(request)
}

export async function POST(request: Request) {
  return handle(request)
}
export async function GET(request: Request) {
  return handle(request)
}
export async function DELETE(request: Request) {
  return handle(request)
}
