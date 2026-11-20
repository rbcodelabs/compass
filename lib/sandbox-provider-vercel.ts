import { APIError, Sandbox, Snapshot, type Command } from "@vercel/sandbox"
import type { PreparedPersistentSandboxStop } from "@/lib/agent-sandbox-fence"
import type {
  BootSandboxOptions,
  CommandHandle,
  CommandResult,
  LogLine,
  NetworkPolicy,
  RunCommandParams,
  SandboxHandle,
  SandboxProvider,
} from "@/lib/sandbox-provider"

/** A started Vercel command. `exitCode` is read live: the SDK updates it when the command finishes. */
class VercelCommandHandle implements CommandHandle {
  constructor(private readonly command: Command) {}

  get cmdId(): string {
    return this.command.cmdId
  }

  get exitCode(): number | null {
    return this.command.exitCode
  }

  logs(opts?: { signal?: AbortSignal }): AsyncIterable<LogLine> {
    return this.command.logs(opts)
  }

  async wait(opts?: { signal?: AbortSignal }): Promise<CommandResult> {
    const finished = await this.command.wait(opts)
    return { exitCode: finished.exitCode }
  }
}

/** Vercel Sandbox behind the provider-neutral handle. Behavior is a move of what callers did inline, not a change. */
class VercelSandboxHandle implements SandboxHandle {
  constructor(private readonly sandbox: Sandbox) {}

  get name(): string {
    return this.sandbox.name
  }

  get status(): string {
    return this.sandbox.status
  }

  get tags(): Record<string, string> | undefined {
    return this.sandbox.tags
  }

  get expiresAt(): Date | undefined {
    return this.sandbox.expiresAt
  }

  runCommand(params: RunCommandParams & { detached: true }): Promise<CommandHandle>
  runCommand(params: RunCommandParams): Promise<CommandResult>
  async runCommand(params: RunCommandParams): Promise<CommandHandle | CommandResult> {
    if (params.detached) {
      return new VercelCommandHandle(await this.sandbox.runCommand({ ...params, detached: true }))
    }
    const finished = await this.sandbox.runCommand(params)
    return { exitCode: finished.exitCode }
  }

  async getCommand(cmdId: string): Promise<CommandHandle | null> {
    try {
      return new VercelCommandHandle(await this.sandbox.currentSession().getCommand(cmdId))
    } catch (error) {
      if (error instanceof APIError && error.response.status === 404) return null
      throw error
    }
  }

  async writeFiles(files: Array<{ path: string; content: string | Uint8Array }>, opts?: { signal?: AbortSignal }): Promise<void> {
    await this.sandbox.writeFiles(files.map((file) => ({ path: file.path, content: Buffer.from(file.content) })), opts)
  }

  async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
    return this.sandbox.readFileToBuffer(file)
  }

  async extendTimeout(durationMs: number): Promise<void> {
    await this.sandbox.extendTimeout(durationMs)
  }

  async updateNetworkPolicy(policy: NetworkPolicy): Promise<void> {
    await this.sandbox.updateNetworkPolicy(toVercelNetworkPolicy(policy))
  }

  async stop(opts?: { signal?: AbortSignal }): Promise<void> {
    await this.sandbox.stop(opts)
  }

  async delete(): Promise<void> {
    await this.sandbox.delete()
  }

  async snapshot(): Promise<{ imageId: string; sizeBytes: number }> {
    const snap = await this.sandbox.currentSession().snapshot()
    return { imageId: snap.snapshotId, sizeBytes: snap.sizeBytes }
  }
}

/**
 * Resolve the named sandbox without resuming it, then keep the specific session
 * for dispatch. A prepared stop can only refer to that session.
 */
async function readVercelSandboxSession(name: string) {
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.get({ name, resume: false })
  } catch (error) {
    if (error instanceof APIError && error.response.status === 404) return { exists: false as const }
    throw error
  }
  try {
    return { exists: true as const, sandbox, session: sandbox.currentSession() }
  } catch (error) {
    // currentSession() throws when the fresh lookup returned no session.
    if (error instanceof Error && error.message.startsWith("No active session.")) {
      return { exists: true as const, sandbox, session: null }
    }
    throw error
  }
}

export async function isVercelSandboxQuiescent(name: string, sessionId: string): Promise<boolean> {
  const found = await readVercelSandboxSession(name)
  if (!found.exists) return false
  if (found.session) {
    if (found.session.sessionId !== sessionId || found.session.status !== "stopped") return false
  } else {
    const { sessions: [latest] } = await found.sandbox.listSessions({ limit: 1, sortOrder: "desc" })
    if (latest?.id !== sessionId || latest.status !== "stopped") return false
  }
  return hasSettledSessionSnapshot(found.sandbox, sessionId)
}

async function hasSettledSessionSnapshot(sandbox: Sandbox, sessionId: string): Promise<boolean> {
  if (!sandbox.currentSnapshotId) return false
  try {
    const snapshot = await Snapshot.get({ snapshotId: sandbox.currentSnapshotId })
    return snapshot.sourceSessionId === sessionId && (snapshot.status === "created" || snapshot.status === "deleted")
  } catch (error) {
    // This lookup targets the advertised snapshot of a verified stopped sandbox.
    // An explicitly absent snapshot leaves the existing launch fallback to replace it.
    if (error instanceof APIError && [404, 410].includes(error.response.status)) return true
    throw error
  }
}

export async function prepareVercelSandboxStop(name: string): Promise<PreparedPersistentSandboxStop | null> {
  const found = await readVercelSandboxSession(name)
  if (!found.exists) return null
  if (!found.session || found.session.status === "stopped") {
    const last = found.session
      ? { id: found.session.sessionId, status: found.session.status }
      : (await found.sandbox.listSessions({ limit: 1, sortOrder: "desc" })).sessions[0]
    if (last?.status !== "stopped" || !(await hasSettledSessionSnapshot(found.sandbox, last.id))) {
      throw new Error("Sandbox paused without a confirmed saved snapshot")
    }
    return null
  }
  const session = found.session
  if (session.status !== "running") throw new Error("Sandbox session has not settled")
  return {
    sessionId: session.sessionId,
    stop: async () => {
      const result = await session.stop()
      if (result.session.status !== "stopped" || result.snapshot?.sourceSessionId !== session.sessionId || result.snapshot.status !== "created") {
        throw new Error("Sandbox pause or saved snapshot has not been confirmed")
      }
    },
  }
}

/** Wrap an SDK sandbox that a Vercel-specific code path created itself (the golden-image builds). */
export function wrapVercelSandbox(sandbox: Sandbox): SandboxHandle {
  return new VercelSandboxHandle(sandbox)
}

/** Compass's policy to the SDK's: `denySubnets` becomes the platform's `subnets.deny`, which takes precedence over the host allowlist. */
export function toVercelNetworkPolicy(policy: NetworkPolicy): Parameters<Sandbox["updateNetworkPolicy"]>[0] {
  if (typeof policy === "string") return policy
  return { allow: policy.allow, ...(policy.denySubnets?.length ? { subnets: { deny: policy.denySubnets } } : {}) }
}

export const vercelSandboxProvider: SandboxProvider = {
  id: "vercel",

  async boot(opts: BootSandboxOptions): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId: opts.snapshotId },
      timeout: opts.timeoutMs,
      // Agent runs always pass a policy (lib/agent-github-access.ts); omitted = the platform default (full egress).
      ...(opts.networkPolicy ? { networkPolicy: toVercelNetworkPolicy(opts.networkPolicy) } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.persistent !== undefined ? { persistent: opts.persistent } : {}),
      // Persistent sandboxes snapshot on every stop; keep only the latest, and let it expire after the retention window.
      ...(opts.snapshotExpirationMs ? { snapshotExpiration: opts.snapshotExpirationMs, keepLastSnapshots: { count: 1 } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return new VercelSandboxHandle(sandbox)
  },

  async getByName(name, opts) {
    return new VercelSandboxHandle(await Sandbox.get(opts?.resume === false ? { name, resume: false } : { name }))
  },

  async stopByName(name) {
    // resume:false: stopping must never boot a stopped sandbox just to stop it again.
    const sandbox = await Sandbox.get({ name, resume: false })
    await sandbox.stop()
  },

  async deleteImage(imageId) {
    const snapshot = await Snapshot.get({ snapshotId: imageId })
    await snapshot.delete()
  },

  isNotFound: (error) => error instanceof APIError && error.response.status === 404,
  // Resuming a stopped persistent sandbox answers 410 "snapshot_not_found" when the platform no longer holds its snapshot.
  isSnapshotGone: (error) => error instanceof APIError && error.response.status === 410,
}
