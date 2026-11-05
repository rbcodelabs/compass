import { APIError, Sandbox, Snapshot } from "@vercel/sandbox"
import type { BootSandboxOptions, SandboxHandle, SandboxProvider } from "@/lib/sandbox-provider"

/** Vercel Sandbox. Behavior here is a move of what lib/agent-sandbox.ts did inline, not a change. */
export const vercelSandboxProvider: SandboxProvider = {
  id: "vercel",

  async boot(opts: BootSandboxOptions): Promise<SandboxHandle> {
    return Sandbox.create({
      source: { type: "snapshot", snapshotId: opts.snapshotId },
      timeout: opts.timeoutMs,
      // Omitted = the platform default (full egress). Set only for shell-enabled turns (lib/agent-github-access.ts).
      ...(opts.networkPolicy ? { networkPolicy: opts.networkPolicy } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.persistent !== undefined ? { persistent: opts.persistent } : {}),
      // Persistent sandboxes snapshot on every stop; keep only the latest, and let it expire after the retention window.
      ...(opts.snapshotExpirationMs ? { snapshotExpiration: opts.snapshotExpirationMs, keepLastSnapshots: { count: 1 } } : {}),
    })
  },

  async getByName(name, opts) {
    return Sandbox.get(opts?.resume === false ? { name, resume: false } : { name })
  },

  async stopByName(name) {
    // resume:false — stopping must never boot a stopped sandbox just to stop it again.
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
