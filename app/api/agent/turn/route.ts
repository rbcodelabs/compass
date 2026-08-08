// In-app agent turn service (ADR 0001, Phase 3).
//
// Session-authed. One POST = one agent turn in a workspace-scoped conversation:
//   1. authenticate the user (NextAuth session) + authorize workspace membership
//   2. persist the user message (creating the conversation if needed)
//   3. mint an ephemeral per-user MCP key (agent acts AS the user → Phase 1
//      per-user authorization scopes every tool it can touch)
//   4. boot a fresh sandbox from the golden snapshot (~200ms, deps pre-installed)
//   5. write + run the turn entry script; stream its output back as SSE
//   6. persist the assistant message + usage; stop the sandbox; revoke the key
//
// Auth: session only (NOT the MCP bearer). The route is allowlisted in
// lib/route-access.ts so the middleware doesn't 302 it, then it enforces the
// session itself (401 otherwise).

import { readFileSync } from "node:fs"
import path from "node:path"
import { NextRequest } from "next/server"
import { auth } from "@/auth"
import getPrisma from "@/lib/db"
import { getGoldenSnapshotId } from "@/lib/agent-runtime-config"
import { bootSandboxFromSnapshot } from "@/lib/agent-sandbox"
import { mintAgentMcpKey, revokeAgentMcpKey } from "@/lib/agent-mcp-key"

export const runtime = "nodejs"
export const maxDuration = 300

const MAX_HISTORY_MESSAGES = 20

function readEntryScript(): string {
  return readFileSync(path.join(process.cwd(), "scripts/agent/turn-entry.ts"), "utf8")
}

/** Assemble the agent prompt from prior turns + the new user message. */
function assemblePrompt(
  history: { role: string; content: string }[],
  userMessage: string
): string {
  const framing =
    "You are Compass's in-app product-discovery assistant. You help the user " +
    "work with THIS workspace's data (opportunities, solutions, experiments, " +
    "roadmap, OKRs, feedback, tasks) using the available Compass tools. Be " +
    "concise. When you change data, say what you changed."
  const transcript = history
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`)
    .join("\n")
  return [framing, transcript, `User: ${userMessage}`, "Assistant:"]
    .filter(Boolean)
    .join("\n\n")
}

export async function POST(request: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 })
  }
  const userId = session.user.id
  const prisma = getPrisma()

  // ── Input ────────────────────────────────────────────────────────────────
  const body = await request.json().catch(() => ({}))
  const workspaceId: unknown = body.workspaceId
  const message: unknown = body.message
  const conversationId: unknown = body.conversationId
  if (typeof workspaceId !== "string" || typeof message !== "string" || !message.trim()) {
    return new Response("workspaceId and a non-empty message are required.", { status: 400 })
  }

  // ── Authorize: caller must be a member of the workspace ─────────────────────
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, members: { some: { userId } } },
    select: { id: true },
  })
  if (!workspace) {
    return new Response("Workspace not found or access denied.", { status: 404 })
  }

  // ── Resolve/verify the conversation (must belong to this user + workspace) ──
  let convo: { id: string } | null = null
  if (typeof conversationId === "string") {
    convo = await prisma.agentConversation.findFirst({
      where: { id: conversationId, userId, workspaceId },
      select: { id: true },
    })
    if (!convo) {
      return new Response("Conversation not found or access denied.", { status: 404 })
    }
  }
  if (!convo) {
    convo = await prisma.agentConversation.create({
      data: {
        workspaceId,
        userId,
        title: message.trim().slice(0, 80),
        updatedAt: new Date(),
      },
      select: { id: true },
    })
  }
  const conversationIdResolved = convo.id

  // ── Runtime prerequisites ──────────────────────────────────────────────────
  const snapshotId = await getGoldenSnapshotId()
  if (!snapshotId) {
    return new Response(
      "Agent runtime is not initialized (no golden snapshot). Run POST /api/admin/rebuild-agent-snapshot.",
      { status: 503 }
    )
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return new Response("ANTHROPIC_API_KEY is not configured on this deployment.", { status: 500 })
  }

  // Persist the user message up front (survives a failed turn).
  await prisma.agentMessage.create({
    data: { conversationId: conversationIdResolved, role: "user", content: message.trim() },
  })

  // Load recent history (excluding the just-added message is fine — it's the tail).
  const historyRows = await prisma.agentMessage.findMany({
    where: { conversationId: conversationIdResolved },
    orderBy: { createdAt: "asc" },
    take: MAX_HISTORY_MESSAGES,
    select: { role: true, content: true },
  })
  const prompt = assemblePrompt(historyRows.slice(0, -1), message.trim())

  const mcpBaseUrl = request.nextUrl.origin
  const bypassSecret = process.env.MCP_BYPASS_SECRET
  const entryScript = readEntryScript()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const sse = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      const { token, apiKeyId } = await mintAgentMcpKey(userId)
      let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>> | undefined
      let assistantText: string | undefined
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let usage: any

      try {
        sse("status", { phase: "booting", conversationId: conversationIdResolved })
        sandbox = await bootSandboxFromSnapshot(snapshotId)

        await sandbox.writeFiles([{ path: "entry.ts", content: entryScript }])
        sse("status", { phase: "running" })

        const run = await sandbox.runCommand({
          cmd: "node",
          args: ["entry.ts"],
          env: {
            ANTHROPIC_API_KEY: anthropicApiKey,
            MCP_BASE_URL: mcpBaseUrl,
            MCP_TOKEN: token,
            AGENT_PROMPT: prompt,
            ...(bypassSecret ? { MCP_BYPASS_SECRET: bypassSecret } : {}),
          },
          detached: true,
          timeoutMs: 4 * 60_000,
        })

        // The entry script writes one JSON object per line, prefixed with a
        // kind. Stdout may arrive in partial chunks, so buffer and split on \n.
        let buffer = ""
        for await (const log of run.logs()) {
          if (log.stream !== "stdout") continue
          buffer += log.data
          let nl: number
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            const sp = line.indexOf(" ")
            const kind = sp === -1 ? line : line.slice(0, sp)
            const rest = sp === -1 ? "" : line.slice(sp + 1)
            if (kind === "AGENT_EVENT") {
              try {
                sse("agent", JSON.parse(rest))
              } catch {
                /* ignore malformed intermediate line */
              }
            } else if (kind === "AGENT_RESULT") {
              const parsed = JSON.parse(rest)
              assistantText = parsed.text
              usage = parsed.usage
            } else if (kind === "AGENT_ERROR") {
              throw new Error(JSON.parse(rest).message ?? "agent error")
            }
          }
        }
        const result = await run.wait()
        if (result.exitCode !== 0 && assistantText === undefined) {
          throw new Error(`agent process exited with code ${result.exitCode}`)
        }

        // Persist the assistant message + usage; bump the conversation.
        await prisma.agentMessage.create({
          data: {
            conversationId: conversationIdResolved,
            role: "assistant",
            content: assistantText ?? "",
            model: "claude-sonnet-5",
            inputTokens: usage?.usage?.input_tokens ?? null,
            outputTokens: usage?.usage?.output_tokens ?? null,
            numTurns: usage?.numTurns ?? null,
            costUsd: usage?.totalCostUsd ?? null,
            durationMs: usage?.durationMs ?? null,
          },
        })
        await prisma.agentConversation.update({
          where: { id: conversationIdResolved },
          data: { updatedAt: new Date() },
        })

        sse("result", { text: assistantText ?? "", usage, conversationId: conversationIdResolved })
      } catch (err) {
        sse("error", { message: err instanceof Error ? err.message : String(err) })
      } finally {
        if (sandbox) {
          try {
            await sandbox.stop()
          } catch {
            /* best-effort */
          }
        }
        await revokeAgentMcpKey(apiKeyId)
        sse("done", {})
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
