/**
 * The seam between Compass's agent code and whichever microVM platform runs it.
 *
 * Implementations: Vercel Sandbox (lib/sandbox-provider-vercel.ts). Nothing in this file may import a platform SDK:
 * these types are the contract a second provider must implement, so they describe what Compass
 * needs from a sandbox, not what one vendor's SDK happens to expose.
 */

/**
 * Egress restriction. A host allowlist is the only policy Compass builds (agentEgressPolicy); the
 * two strings are the endpoints. Providers that cannot express a policy natively enforce it
 * another way (for example a network namespace behind an allowlist proxy), or refuse to boot when asked for one they cannot enforce.
 */
export type NetworkPolicy = "allow-all" | "deny-all" | { allow: string[] }

/** One line of a command's output. */
export type LogLine = { stream: "stdout" | "stderr"; data: string }

export type RunCommandParams = {
  cmd: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  /** Run as root. Otherwise as the sandbox's default (unprivileged) user. */
  sudo?: boolean
  /** Return as soon as the command starts; the sandbox keeps running it (bounded by `timeoutMs`). */
  detached?: boolean
  signal?: AbortSignal
  /** Enforced by the sandbox, so it holds whether or not anyone awaits the command (including detached). */
  timeoutMs?: number
}

export type CommandResult = { exitCode: number }

/** A started command. `exitCode` is null until it finishes. */
export interface CommandHandle {
  readonly cmdId: string
  readonly exitCode: number | null
  logs(opts?: { signal?: AbortSignal }): AsyncIterable<LogLine>
  wait(opts?: { signal?: AbortSignal }): Promise<CommandResult>
}

/** What the platform reports. Compared as plain strings by the reuse decision (lib/agent-sandbox-reuse.ts). */
export type SandboxStatus = string

export interface SandboxHandle {
  readonly name: string
  readonly status: SandboxStatus
  readonly tags: Record<string, string> | undefined
  /** When the platform will stop it, if it says. */
  readonly expiresAt: Date | undefined

  runCommand(params: RunCommandParams & { detached: true }): Promise<CommandHandle>
  runCommand(params: RunCommandParams): Promise<CommandResult>
  /** Look up a command started earlier, for a caller holding only its id. Null if unknown. */
  getCommand(cmdId: string): Promise<CommandHandle | null>

  writeFiles(files: Array<{ path: string; content: string | Uint8Array }>, opts?: { signal?: AbortSignal }): Promise<void>
  /** Null when the file does not exist. */
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>

  /** Add to the platform lifetime. */
  extendTimeout(durationMs: number): Promise<void>
  updateNetworkPolicy(policy: NetworkPolicy): Promise<void>

  /**
   * Stop it and save its state as a new image, returning the image id. Ends the session, so do not
   * stop() afterwards. Only providers whose images are made by snapshotting a built sandbox support
   * this (Vercel). Providers that build images from a recipe throw.
   */
  snapshot(): Promise<{ imageId: string; sizeBytes: number }>

  /** Stop it (for a persistent sandbox: pause, keeping the disk). */
  stop(opts?: { signal?: AbortSignal }): Promise<void>
  /** Remove it and its saved state. */
  delete(): Promise<void>
}

export type BootSandboxOptions = {
  /** Source image: a golden image id. */
  snapshotId: string
  timeoutMs: number
  /** Makes the sandbox addressable later (`getByName`), which is how the sweeper reaches a run nobody is watching. */
  name?: string
  /** Cost-attribution labels. */
  tags?: Record<string, string>
  /** Egress restriction for the sandbox's whole lifetime; applied at creation, before any shell can run. */
  networkPolicy?: NetworkPolicy
  /** Persistent sandboxes keep their disk across stop/resume. */
  persistent?: boolean
  snapshotExpirationMs?: number
  signal?: AbortSignal
}

export interface SandboxProvider {
  /** Stable identifier recorded in logs, e.g. "vercel". */
  readonly id: string

  boot(options: BootSandboxOptions): Promise<SandboxHandle>

  /**
   * Look a sandbox up by name. `resume: false` must never start a stopped sandbox. Throws an error
   * for which `isNotFound` is true when no sandbox has that name.
   */
  getByName(name: string, opts?: { resume?: boolean }): Promise<SandboxHandle>

  /** Stop (for a persistent sandbox: pause) a sandbox by name, without booting it first. */
  stopByName(name: string): Promise<void>

  /** Delete a golden image. Callers guarantee it is no longer the current one. */
  deleteImage(imageId: string): Promise<void>

  /** No sandbox with that name exists. */
  isNotFound(error: unknown): boolean
  /** A stopped persistent sandbox cannot resume because its saved disk is gone. */
  isSnapshotGone(error: unknown): boolean
}
