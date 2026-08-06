// EXPERIMENTAL SPIKE ROUTE — not production surface.
//
// Proves that @anthropic-ai/claude-agent-sdk can run server-side inside
// Compass via @vercel/sandbox, calling back into Compass's own existing MCP
// tool catalog (app/api/mcp/route.ts). This is a throwaway learning route
// for a spike, not the final in-app agent feature — see
// Claude/agent-sdk-sandbox-spike-2026-08-06.md for the findings and the
// follow-up build plan.
//
// Two modes (Phase 0 snapshot de-risk measurement — see the vault note):
//
//   POST ?mode=build
//     Creates a sandbox, writes package.json + entry.ts, runs npm install,
//     then snapshots the running session (session.snapshot()) so the baked
//     filesystem (node_modules + entry script) can be reused. Does NOT run
//     the agent. Returns the snapshotId + snapshot-creation timing. This is
//     the one-time "warm build" step.
//
//   POST ?snapshotId=<id>   (warm path — the per-turn cost we care about)
//     Boots a fresh sandbox FROM the snapshot (no npm install, no file
//     writes — deps and entry.ts are already baked), runs the Agent SDK
//     query(), and reports boot-complete time, time-to-first-agent-output
//     (TTFT), and total round trip. Compare against the cold ~28s baseline.
//
//   POST (no params)  — original cold path: create → install → run.
//
// Secrets (ANTHROPIC_API_KEY etc.) are passed at runCommand time only, never
// during the build/snapshot step, so they are never baked into a snapshot.
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

const SANDBOX_PACKAGE_JSON = JSON.stringify(
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
)

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
  // Optional: only needed when this deployment is itself behind Vercel's
  // project-level deployment protection (SSO), so the sandbox's outbound
  // call back to this same deployment's /api/mcp can get past it. Separate
  // trust boundary from MCP_API_KEY, which is the app-level auth check.
  const spikeMcpBypassSecret = process.env.SPIKE_MCP_BYPASS_SECRET
  const entryScript = readEntryScript()

  const mode = request.nextUrl.searchParams.get("mode")
  const snapshotId = request.nextUrl.searchParams.get("snapshotId") ?? undefined
  const isBuild = mode === "build"

  const startedAt = Date.now()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (line: string) => {
        controller.enqueue(encoder.encode(`[t+${Date.now() - startedAt}ms] ${line}\n`))
      }

      // Runs the baked/installed agent script and marks time-to-first-output.
      const runAgent = async (sandbox: Sandbox) => {
        emit("Running Agent SDK query() inside the sandbox...")
        const runStartedAt = Date.now()
        const run = await sandbox.runCommand({
          cmd: "node",
          args: ["entry.ts"],
          env: {
            ANTHROPIC_API_KEY: anthropicApiKey,
            MCP_API_KEY: mcpApiKey,
            MCP_BASE_URL: mcpBaseUrl,
            ...(spikeMcpBypassSecret
              ? { SPIKE_MCP_BYPASS_SECRET: spikeMcpBypassSecret }
              : {}),
          },
          detached: true,
          timeoutMs: 4 * 60_000,
        })
        let firstOutputAt: number | undefined
        for await (const log of run.logs()) {
          if (firstOutputAt === undefined) {
            firstOutputAt = Date.now()
            emit(`METRIC time_to_first_agent_output_ms=${firstOutputAt - runStartedAt}`)
          }
          emit(`[agent:${log.stream}] ${log.data}`)
        }
        const runResult = await run.wait()
        emit(`Agent script finished, exit=${runResult.exitCode}`)
        if (runResult.exitCode !== 0) {
          throw new Error(`Agent script exited with code ${runResult.exitCode}`)
        }
      }

      let sandbox: Sandbox | undefined
      let snapshotted = false
      try {
        if (snapshotId) {
          // ---- WARM PATH: boot from an existing snapshot, skip install ----
          emit(`Booting sandbox FROM snapshot ${snapshotId} (warm path)...`)
          const bootStartedAt = Date.now()
          sandbox = await Sandbox.create({
            source: { type: "snapshot", snapshotId },
            timeout: 5 * 60_000,
          })
          emit(`METRIC warm_boot_ms=${Date.now() - bootStartedAt}`)
          emit(`Sandbox booted from snapshot: ${sandbox.name} (sourceSnapshotId=${sandbox.sourceSnapshotId})`)

          await runAgent(sandbox)
          emit("Done (warm path).")
        } else {
          // ---- BUILD or COLD PATH: create fresh, write files, install ----
          emit("Creating Vercel Sandbox (runtime: node24)...")
          const createStartedAt = Date.now()
          sandbox = await Sandbox.create({
            runtime: "node24",
            timeout: 5 * 60_000,
          })
          emit(`METRIC cold_create_ms=${Date.now() - createStartedAt}`)
          emit(`Sandbox created: ${sandbox.name}`)

          emit("Writing package.json + entry script into sandbox...")
          await sandbox.writeFiles([
            { path: "package.json", content: SANDBOX_PACKAGE_JSON },
            { path: "entry.ts", content: entryScript },
          ])

          emit("Running npm install inside the sandbox (cold start, can take a while)...")
          const installStartedAt = Date.now()
          const install = await sandbox.runCommand({
            cmd: "npm",
            args: ["install", "--no-audit", "--no-fund"],
            detached: true,
          })
          for await (const log of install.logs()) {
            emit(`[npm:${log.stream}] ${log.data}`)
          }
          const installResult = await install.wait()
          emit(`METRIC npm_install_ms=${Date.now() - installStartedAt}`)
          emit(`npm install finished, exit=${installResult.exitCode}`)
          if (installResult.exitCode !== 0) {
            throw new Error(`npm install failed with exit code ${installResult.exitCode}`)
          }

          if (isBuild) {
            // Snapshot the freshly-installed session so warm boots can reuse
            // it. NOTE: snapshot() stops the session, so no agent run here.
            emit("Creating snapshot from the installed session (session.snapshot())...")
            const snapStartedAt = Date.now()
            const snap = await sandbox.currentSession().snapshot()
            snapshotted = true
            emit(`METRIC snapshot_create_ms=${Date.now() - snapStartedAt}`)
            emit(`SNAPSHOT_ID=${snap.snapshotId}`)
            emit(
              `Snapshot ready: status=${snap.status} sizeBytes=${snap.sizeBytes} ` +
                `expiresAt=${snap.expiresAt?.toISOString() ?? "never"}`
            )
            emit("Done (build path). Re-invoke with ?snapshotId=<id> to measure the warm boot.")
          } else {
            await runAgent(sandbox)
            emit("Done (cold path).")
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        emit(`ERROR: ${message}`)
      } finally {
        // In build mode session.snapshot() already stopped the session;
        // calling stop() again would error, so skip it.
        if (sandbox && !snapshotted) {
          try {
            await sandbox.stop()
            emit("Sandbox stopped.")
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            emit(`Failed to stop sandbox cleanly: ${message}`)
          }
        }
        emit(`METRIC total_round_trip_ms=${Date.now() - startedAt}`)
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
