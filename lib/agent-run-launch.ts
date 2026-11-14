/**
 * Starting a queued agent run's sandbox, with no HTTP request in sight.
 *
 * The turn route (a person typing in chat) boots its own sandbox inline. A run started by an assignment, a mention
 * (lib/agent-task-trigger.ts), a scheduled wake-up, or a deadline-parked question answer (lib/agent-continuation-run.ts)
 * has no streaming chat request to ride on, so the same steps live here:
 *
 *   1. prepare the capability packs, record their provenance on the run;
 *   2. mint the MCP key and attach it to the run BEFORE the sandbox exists, because an agent key is honoured only
 *      while a live run names it (lib/agent-run-identity.ts), so the agent's very first tool call must find one;
 *   3. boot (or reuse/resume the conversation sandbox), write the entry files, start the command detached;
 *   4. only then QUEUED -> RUNNING.
 *
 * A failure at any step revokes the key and finalizes the run FAILED, which writes the failure into the conversation: the
 * caller was told "started", so a start that does not happen has to leave a visible trace, not a silent QUEUED row.
 */
import type { AppPrismaClient } from "@/lib/db"
import { bootSandboxFromSnapshot, stopSandboxByName } from "@/lib/agent-sandbox"
import { AGENT_SANDBOX_IDLE_MS, agentSandboxReuseEnabled, sandboxNetworkProfile } from "@/lib/agent-sandbox-reuse"
import { agentModelForHarness, type AgentHarness } from "@/lib/agent-harness"
import { mintAgentMcpKey, revokeAgentMcpKey } from "@/lib/agent-mcp-key"
import { getCapabilityPackArtifactStorage } from "@/lib/artifact-storage"
import { prepareCapabilityPacksForTurn, type ActiveCapabilityPack } from "@/lib/capability-pack-runtime"
import {
  agentConversationSandboxName,
  attachAgentRunKey,
  finalizeAgentRun,
  findPreviousRunForSandboxReuse,
  markAgentRunStarted,
} from "@/lib/agent-runs"
import { effectiveTurnModel } from "@/lib/agent-turn-model"
import { buildAgentEnv, readEntryModules, readEntryScript, RUN_INFRA_GRACE_MS } from "@/lib/agent-run-sandbox"
import { agentEgressPolicy, githubShellEnabled } from "@/lib/agent-github-access"
import * as docFs from "@/lib/doc-fs"
import type { DocBaselineEntry } from "@/lib/agent-doc-reconciliation"
import { selectMaterializable } from "@/lib/agent-doc-materialize"
import { DOC_MANIFEST_FILE, signDocManifest } from "@/lib/agent-doc-manifest"
import type { AgentRecord } from "@/lib/agent-ownership"
import type { ResolvedAgentModel } from "@/lib/agent-model"

export type LaunchContext = {
  prisma: AppPrismaClient
  run: { id: string; deadlineAt: Date }
  workerToken: string
  sandboxName: string
  /** The human who started the run: the key's user, and the one run-attributed usage is charged to. */
  userId: string
  workspace: { id: string }
  /** Null/omitted for the built-in Compass Agent; populated when running as a named Cloud Agent. */
  agent?: Pick<AgentRecord, "id" | "name" | "instructions" | "model"> | null
  /** Complete text prompt (or resume delta prompt when `session` is provided). */
  prompt: string
  snapshotId: string
  harness: AgentHarness
  /** Resolved model provider + credential; required for the Claude harness. */
  model?: Extract<ResolvedAgentModel, { ok: true }>
  gatewayApiKey?: string
  budgetMs: number
  mcpBaseUrl: string
  bypassSecret?: string
  /** Optional Agent SDK session continuity metadata (`session-in.jsonl.gz` passed via `extraFiles`). */
  session?: { sessionId: string; mode: "new" | "resume" }
  /** Additional per-turn sandbox files (e.g. `session-in.jsonl.gz` and `fallback-prompt.txt`). */
  extraFiles?: { path: string; content: Buffer | string }[]
  /** Shared multi-participant conversation flag forwarded to `buildAgentEnv`. */
  shared?: boolean
  /** Materialize the workspace doc tree so continuation turns see & reconcile `_doc.md` files. */
  docs?: boolean
  githubEnv?: Record<string, string> | null
  developer?: { enabled: boolean; npmToken?: string }
  /** Opt-in persistent conversation sandbox reuse (warm hit inside idle window, or disk resume). */
  reuseConversationSandbox?: { conversationId: string; developer: boolean }
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

async function materializeLaunchDocTree(workspaceId: string): Promise<{
  baseline: DocBaselineEntry[]
  files: { path: string; content: string }[]
}> {
  const nodes = await docFs.listPaths(workspaceId)
  const read: (DocBaselineEntry & { content: string })[] = []
  for (const node of nodes) {
    const doc = await docFs.readDocById(workspaceId, node.docId)
    if (!doc) continue
    read.push({ path: node.path, docId: doc.docId, revision: doc.revision, content: doc.content })
  }
  const { included } = selectMaterializable(read)
  return {
    baseline: included.map((entry) => ({ path: entry.path, docId: entry.docId, revision: entry.revision, content: entry.content })),
    files: included.map((entry) => ({ path: `docs/${entry.path}/_doc.md`, content: entry.content })),
  }
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
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        packProvenance: preparedPacks.provenanceJson,
        model: effectiveTurnModel({ explicit: null, agentModel: ctx.agent?.model, harness: ctx.harness }).slice(0, 100),
        updatedAt: new Date(),
      },
      select: { id: true },
    })

    const minted = await mintAgentMcpKey(
      ctx.userId,
      ctx.workspace.id,
      undefined,
      new Date(run.deadlineAt.getTime() + RUN_INFRA_GRACE_MS),
      { agentId: ctx.agent?.id ?? null },
    )
    apiKeyId = minted.apiKeyId
    if (!(await attachAgentRunKey({ prisma, runId: run.id, apiKeyId }))) {
      throw new Error("agent run ended before its key could be attached")
    }

    const materializeDocs = Boolean(ctx.docs) && ctx.harness !== "opencode"
    const githubShell = githubShellEnabled({
      githubEnv: ctx.githubEnv ?? undefined,
      harness: ctx.harness,
      docs: materializeDocs,
    })
    const networkPolicy = githubShell
      ? agentEgressPolicy({
          mcpBaseUrl: ctx.mcpBaseUrl,
          model: ctx.model,
          developer: Boolean(ctx.developer?.enabled),
        })
      : undefined

    const reuseTarget =
      ctx.reuseConversationSandbox && ctx.harness === "claude" && agentSandboxReuseEnabled()
        ? ctx.reuseConversationSandbox
        : null
    const runSandboxName = reuseTarget
      ? agentConversationSandboxName(reuseTarget.conversationId, { developer: reuseTarget.developer })
      : ctx.sandboxName

    let sandbox: Awaited<ReturnType<typeof bootSandboxFromSnapshot>>
    if (!reuseTarget) {
      sandbox = await bootSandboxFromSnapshot(ctx.snapshotId, {
        timeoutMs: ctx.budgetMs + 2 * RUN_INFRA_GRACE_MS,
        name: runSandboxName,
        tags: { runId: run.id, workspaceId: ctx.workspace.id },
        ...(networkPolicy ? { networkPolicy } : {}),
      })
    } else {
      await prisma.agentRun.updateMany({
        where: { id: run.id, status: "QUEUED" },
        data: { sandboxName: runSandboxName },
      })
      const previous = await findPreviousRunForSandboxReuse(prisma, reuseTarget.conversationId, run.id)
      const requiredMs = ctx.budgetMs + 2 * RUN_INFRA_GRACE_MS
      const profile = sandboxNetworkProfile(networkPolicy)
      const { acquireConversationSandbox } = await import("@/lib/agent-sandbox")
      const acquired = await acquireConversationSandbox({
        name: runSandboxName,
        snapshotId: ctx.snapshotId,
        profile,
        previous,
        requiredMs,
        boot: {
          timeoutMs: requiredMs + AGENT_SANDBOX_IDLE_MS,
          tags: { runId: run.id, workspaceId: ctx.workspace.id, snapshotId: ctx.snapshotId, profile },
          ...(networkPolicy ? { networkPolicy } : {}),
        },
      })
      sandbox = acquired.sandbox
    }

    const docMaterial = materializeDocs ? await materializeLaunchDocTree(ctx.workspace.id) : undefined
    const manifestFiles = docMaterial
      ? [{ path: DOC_MANIFEST_FILE, content: JSON.stringify(signDocManifest(run.id, ctx.workspace.id, docMaterial.baseline)) }]
      : []

    await sandbox.writeFiles([
      { path: "entry.ts", content: readEntryScript(ctx.harness) },
      ...readEntryModules(ctx.harness),
      ...(docMaterial?.files ?? []),
      ...manifestFiles,
      ...(ctx.extraFiles ?? []),
      // Pack plugin dirs are Claude SDK plugins; opencode gets pack skills via the system prompt only.
      ...(ctx.harness === "opencode" ? [] : preparedPacks.files),
    ])
    await sandbox.runCommand({
      cmd: "node",
      args: ["entry.ts"],
      env: buildAgentEnv({
        harness: ctx.harness,
        model: ctx.model,
        gatewayApiKey: ctx.gatewayApiKey,
        connectors: [],
        mcpBaseUrl: ctx.mcpBaseUrl,
        mcpToken: minted.token,
        prompt: ctx.prompt,
        session: ctx.session,
        workspaceId: ctx.workspace.id,
        systemPromptAppendices: preparedPacks.systemPromptAppendices,
        pluginPaths: preparedPacks.pluginPaths,
        skillIds: preparedPacks.skillIds,
        bypassSecret: ctx.bypassSecret,
        run: { runId: run.id, workerToken: ctx.workerToken },
        shared: ctx.shared,
        docs: Boolean(docMaterial),
        agent: ctx.agent
          ? {
              name: ctx.agent.name,
              instructions: ctx.agent.instructions ?? null,
              model: agentModelForHarness(ctx.agent.model, ctx.harness),
            }
          : undefined,
        githubEnv: ctx.githubEnv ?? undefined,
        developer: ctx.developer,
      }),
      detached: true,
      timeoutMs: ctx.budgetMs,
    })
    if (!(await markAgentRunStarted({ prisma, runId: run.id, apiKeyId, sandboxName: runSandboxName }))) {
      console.warn("[agent-run-launch] run ended before its start was recorded; stopping the sandbox", { runId: run.id })
      try {
        await revokeAgentMcpKey(apiKeyId)
      } catch {
        /* never throws in practice; teardown continues either way */
      }
      try {
        await stopSandboxByName(runSandboxName)
      } catch {
        /* the sandbox's own timeout is the backstop */
      }
      return { started: false }
    }
    return { started: true }
  } catch (error) {
    console.error("[agent-run-launch] triggered run failed to start", { runId: run.id, error })
    if (apiKeyId) await revokeAgentMcpKey(apiKeyId)
    await finalizeAgentRun({
      prisma,
      runId: run.id,
      status: "FAILED",
      error: "The agent run could not start.",
      errorCode: "RUN_START_FAILED",
    }).catch(() => {})
    return { started: false }
  }
}
