// EXPERIMENTAL SPIKE ROUTE — not production surface.
//
// Proves that @anthropic-ai/claude-agent-sdk can run server-side inside
// Compass via @vercel/sandbox, calling back into Compass's own existing MCP
// tool catalog (app/api/mcp/route.ts). This is a throwaway learning route
// for a spike, not the final in-app agent feature — see
// Claude/agent-sdk-sandbox-spike-2026-08-06.md for the findings and the
// follow-up build plan.
//
// POST with no body. Streams plain-text progress as the sandbox boots,
// installs dependencies, and runs the Agent SDK query() against the fixed
// test prompt "What workspaces exist for org rbcodelabs?".
//
// Auth: reuses the existing MCP_API_KEY bearer-token contract from
// lib/mcp-auth.ts (Authorization: Bearer <MCP_API_KEY>) rather than
// introducing a new auth mechanism for a throwaway spike route. This is
// deliberately the *service-account* key, not per-user ApiKey scoping --
// that's explicitly deferred to the follow-up full-build plan.

import { readFileSync } from "fs"
import path from "path"
import { NextRequest } from "next/server"
import { Sandbox } from "@vercel/sandbox"
import { validateMcpAuth } from "@/lib/mcp-auth"

export const runtime = "nodejs"
export const maxDuration = 300

function readEntryScript(): string {
  return readFileSync(
    path.join(process.cwd(), "scripts/spike/agent-sandbox-entry.ts"),
    "utf8"
  )
}

export async function POST(request: NextRequest) {
  const auth = await validateMcpAuth(request)
  if (!auth.valid) {
    return new Response("Unauthorized", { status: 401 })
  }

  const mcpApiKey = process.env.MCP_API_KEY
  if (!mcpApiKey) {
    return new Response("MCP_API_KEY is not configured on this deployment.", { status: 500 })
  }
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicApiKey) {
    return new Response("ANTHROPIC_API_KEY is not configured on this deployment.", { status: 500 })
  }

  const mcpBaseUrl = request.nextUrl.origin
  const entryScript = readEntryScript()
  const startedAt = Date.now()

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (line: string) => {
        controller.enqueue(encoder.encode(`[t+${Date.now() - startedAt}ms] ${line}\n`))
      }

      let sandbox: Sandbox | undefined
      try {
        emit("Creating Vercel Sandbox (runtime: node24)...")
        sandbox = await Sandbox.create({
          runtime: "node24",
          timeout: 5 * 60_000,
        })
        emit(`Sandbox created: ${sandbox.name}`)

        emit("Writing package.json + entry script into sandbox...")
        await sandbox.writeFiles([
          {
            path: "package.json",
            content: JSON.stringify(
              {
                name: "agent-sandbox-spike",
                private: true,
                type: "module",
                dependencies: {
                  "@anthropic-ai/claude-agent-sdk": "^0.3.222",
                  "@modelcontextprotocol/sdk": "^1.29.0",
                  zod: "^4.0.0",
                },
              },
              null,
              2
            ),
          },
          { path: "entry.ts", content: entryScript },
        ])

        emit("Running npm install inside the sandbox (cold start, can take a while)...")
        const install = await sandbox.runCommand({
          cmd: "npm",
          args: ["install", "--no-audit", "--no-fund"],
          detached: true,
        })
        for await (const log of install.logs()) {
          emit(`[npm:${log.stream}] ${log.data}`)
        }
        const installResult = await install.wait()
        emit(`npm install finished, exit=${installResult.exitCode}`)
        if (installResult.exitCode !== 0) {
          throw new Error(`npm install failed with exit code ${installResult.exitCode}`)
        }

        emit("Running Agent SDK query() inside the sandbox...")
        const run = await sandbox.runCommand({
          cmd: "node",
          args: ["entry.ts"],
          env: {
            ANTHROPIC_API_KEY: anthropicApiKey,
            MCP_API_KEY: mcpApiKey,
            MCP_BASE_URL: mcpBaseUrl,
          },
          detached: true,
          timeoutMs: 4 * 60_000,
        })
        for await (const log of run.logs()) {
          emit(`[agent:${log.stream}] ${log.data}`)
        }
        const runResult = await run.wait()
        emit(`Agent script finished, exit=${runResult.exitCode}`)

        if (runResult.exitCode !== 0) {
          throw new Error(`Agent script exited with code ${runResult.exitCode}`)
        }

        emit("Done.")
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit(`ERROR: ${message}`)
      } finally {
        if (sandbox) {
          try {
            await sandbox.stop()
            emit("Sandbox stopped.")
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            emit(`Failed to stop sandbox cleanly: ${message}`)
          }
        }
        emit(`Total round trip: ${Date.now() - startedAt}ms`)
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
