/**
 * Starting a queued agent run's sandbox, with no HTTP request in sight.
 *
 * The turn route (a person typing in chat) boots its own sandbox inline. A run started by an assignment or a mention
 * (lib/agent-task-trigger.ts) has no chat request to ride on, so the same steps live here, as one function the trigger
 * schedules after it has answered the person who made the assignment. The order is the route's detached path and matters for
 * the same reasons:
 *
 *   1. prepare the capability packs, record their provenance on the run;
 *   2. mint the agent-scoped MCP key and attach it to the run BEFORE the sandbox exists, because an agent key is honoured only
 *      while a live run names it (lib/agent-run-identity.ts), so the agent's very first tool call must find one;
 *   3. boot, write the entry files, start the command detached;
 *   4. only then QUEUED -> RUNNING.
 *
 * A failure at any step revokes the key and finalizes the run FAILED, which writes the failure into the conversation: the
 * person was told "started", so a start that does not happen has to leave a visible trace, not a silent QUEUED row (the
 * sweeper would also collect it, later).
 */
import type { AppPrismaClient } from "@/lib/db"
import { bootSandboxFromSnapshot } from "@/lib/agent-sandbox"
import { agentModelForHarness, type AgentHarness } from "@/lib/agent-harness"
import { mintAgentMcpKey, revokeAgentMcpKey } from "@/lib/agent-mcp-key"
import { getCapabilityPackArtifactStorage } from "@/lib/artifact-storage"
import { prepareCapabilityPacksForTurn, type ActiveCapabilityPack } from "@/lib/capability-pack-runtime"
import { attachAgentRunKey, finalizeAgentRun, markAgentRunStarted } from "@/lib/agent-runs"
import { buildAgentEnv, readEntryModules, readEntryScript, RUN_INFRA_GRACE_MS } from "@/lib/agent-run-sandbox"
import type { AgentRecord } from "@/lib/agent-ownership"

export type LaunchContext = {
  prisma: AppPrismaClient
  run: { id: string; deadlineAt: Date }
  workerToken: string
  sandboxName: string
  /** The human who started the run: the key's user, and the one run-attributed usage is charged to. */
  userId: string
  workspace: { id: string }
  agent: Pick<AgentRecord, "id" | "name" | "instructions" | "model">
  /** The complete text prompt (no session resume: a triggered run starts fresh). */
  prompt: string
  snapshotId: string
  harness: AgentHarness
  anthropicApiKey?: string
  gatewayApiKey?: string
  budgetMs: number
  mcpBaseUrl: string
  bypassSecret?: string
}

async function activePacksFor(prisma: AppPrismaClient, workspaceId: string): Promise<ActiveCapabilityPack[]> {
  const attachments = await prisma.workspaceCapabilityPack.findMany({
    where: { workspaceId, enabled: true },
    include: { capabilityPackVersion: { include: { capabilityPack: true } } },
    orderBy: { createdAt: "asc" },
  })
  return attachments.map((attachment) => ({
    packId: attachment.capabilityPackVersion.capabilityPack.packId,
    version: attachment.capabilityPackVersion.semanticVersion,
    commit: attachment.capabilityPackVersion.sourceCommit,
    digest: attachment.capabilityPackVersion.artifactSha256,
    pathname: attachment.capabilityPackVersion.artifactPathname,
    enabledSkills: JSON.parse(attachment.enabledSkillIds) as string[],
    manifestJson: attachment.capabilityPackVersion.manifestJson,
  }))
}

/** Boots the sandbox for a QUEUED run. Never throws: a failed start finalizes the run FAILED and resolves `started: false`. */
export async function launchQueuedAgentRun(ctx: LaunchContext): Promise<{ started: boolean }> {
  const { prisma, run } = ctx
  let apiKeyId: string | undefined
  try {
    const preparedPacks = await prepareCapabilityPacksForTurn(await activePacksFor(prisma, ctx.workspace.id), {
      get: (pathname) => getCapabilityPackArtifactStorage().get(pathname),
    })
    // Stamped before the sandbox exists, so no audit row derived from this run's events can read an empty provenance.
    await prisma.agentRun.update({ where: { id: run.id }, data: { packProvenance: preparedPacks.provenanceJson, updatedAt: new Date() }, select: { id: true } })

    const minted = await mintAgentMcpKey(ctx.userId, ctx.workspace.id, undefined, new Date(run.deadlineAt.getTime() + RUN_INFRA_GRACE_MS), { agentId: ctx.agent.id })
    apiKeyId = minted.apiKeyId
    if (!(await attachAgentRunKey({ prisma, runId: run.id, apiKeyId }))) throw new Error("agent run ended before its key could be attached")

    const sandbox = await bootSandboxFromSnapshot(ctx.snapshotId, {
      timeoutMs: ctx.budgetMs + 2 * RUN_INFRA_GRACE_MS,
      name: ctx.sandboxName,
      tags: { runId: run.id, workspaceId: ctx.workspace.id },
    })
    await sandbox.writeFiles([
      { path: "entry.ts", content: readEntryScript(ctx.harness) },
      ...readEntryModules(ctx.harness),
      // Pack plugin dirs are Claude SDK plugins; opencode gets pack skills via the system prompt only.
      ...(ctx.harness === "opencode" ? [] : preparedPacks.files),
    ])
    await sandbox.runCommand({
      cmd: "node",
      args: ["entry.ts"],
      env: buildAgentEnv({
        harness: ctx.harness,
        anthropicApiKey: ctx.anthropicApiKey ?? "",
        gatewayApiKey: ctx.gatewayApiKey,
        // A named agent never borrows its invoker's connected third-party accounts, and a triggered run has no file tree.
        connectors: [],
        mcpBaseUrl: ctx.mcpBaseUrl,
        mcpToken: minted.token,
        prompt: ctx.prompt,
        workspaceId: ctx.workspace.id,
        systemPromptAppendices: preparedPacks.systemPromptAppendices,
        pluginPaths: preparedPacks.pluginPaths,
        skillIds: preparedPacks.skillIds,
        bypassSecret: ctx.bypassSecret,
        run: { runId: run.id, workerToken: ctx.workerToken },
        docs: false,
        agent: { name: ctx.agent.name, instructions: ctx.agent.instructions ?? null, model: agentModelForHarness(ctx.agent.model, ctx.harness) },
      }),
      detached: true,
      timeoutMs: ctx.budgetMs,
    })
    await markAgentRunStarted({ prisma, runId: run.id, apiKeyId, sandboxName: ctx.sandboxName })
    return { started: true }
  } catch (error) {
    console.error("[agent-run-launch] triggered run failed to start", { runId: run.id, error })
    if (apiKeyId) await revokeAgentMcpKey(apiKeyId)
    await finalizeAgentRun({ prisma, runId: run.id, status: "FAILED", error: "The agent run could not start.", errorCode: "RUN_START_FAILED" }).catch(() => {})
    return { started: false }
  }
}
