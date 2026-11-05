/**
 * The seam between Compass's agent code and whichever microVM platform runs it.
 *
 * Today the only implementation is Vercel Sandbox (lib/sandbox-provider-vercel.ts). The AWS
 * migration adds a second one behind this same interface; see the "Sandbox substrate: AWS
 * microVMs" ADR under Architecture Decisions in the bankrate/compass-internal workspace.
 *
 * Scope of this first step: the *provider operations* (boot, look up, stop, delete a snapshot,
 * classify errors) go through the interface. `SandboxHandle` is a structural subset of the
 * Vercel SDK's `Sandbox`, i.e. exactly the methods callers use today, so existing call sites
 * keep working unchanged. Decoupling the handle's parameter and result types from the SDK
 * (RunCommandParams, NetworkPolicy, CommandFinished) is the next step and is needed before a
 * second provider can be written; it is deliberately not done here to keep this change free of
 * behavior risk.
 */

import type { NetworkPolicy, Sandbox } from "@vercel/sandbox"

export type { NetworkPolicy }

/** The sandbox methods callers rely on. Keep this list minimal: every entry is something a second provider must implement. */
export type SandboxHandle = Pick<
  Sandbox,
  | "name"
  | "status"
  | "tags"
  | "expiresAt"
  | "runCommand"
  | "writeFiles"
  | "readFileToBuffer"
  | "extendTimeout"
  | "updateNetworkPolicy"
  | "currentSession"
  | "stop"
  | "delete"
>

export type BootSandboxOptions = {
  /** Source image: for Vercel, a golden snapshot id. */
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
}

export interface SandboxProvider {
  /** Stable identifier recorded in logs and ADR notes, e.g. "vercel" or "aws-agentcore". */
  readonly id: string

  boot(options: BootSandboxOptions): Promise<SandboxHandle>

  /**
   * Look a sandbox up by name. `resume: false` must never start a stopped sandbox. Throws a
   * not-found error (see `isNotFound`) when no sandbox has that name.
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
