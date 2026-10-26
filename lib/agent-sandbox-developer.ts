/**
 * The DEVELOPER sandbox class: a second golden snapshot layered on the STANDARD one.
 *
 * It boots from the STANDARD snapshot (agent SDK, Chromium, gh already baked in) and adds only the delta a
 * coding agent needs to run a project end to end: a local PostgreSQL 16 cluster, pnpm, a second Node line,
 * and a native-module toolchain. Then it snapshots again. Layering (rather than a second full recipe) keeps
 * the two from drifting and makes a rebuild skip `npm install` and the Chromium download.
 *
 * Staleness has two inputs: the recipe fingerprint below (which includes the STANDARD fingerprint, so any
 * STANDARD recipe change invalidates this layer) and `baseSnapshotId` (a STANDARD rebuild yields a new id
 * even when the recipe is unchanged). Rebuild STANDARD first, then this.
 *
 * A feasibility spike on real Vercel Sandbox showed: a snapshot of a snapshot-booted sandbox works, a derived
 * snapshot survives deletion of its base, `postgresql16-server postgresql16-contrib` install on Amazon Linux
 * 2023 and `initdb` runs as the unprivileged user. NOT yet verified under a realistic load (see the ADR).
 */

import { createHash } from "node:crypto"
import { Sandbox } from "@vercel/sandbox"
import { bootSandboxFromSnapshot, computeDepsFingerprint, runStep } from "@/lib/agent-sandbox"

const BUILD_TIMEOUT_MS = 15 * 60_000

/** Build and native-module toolchain plus Postgres. Installed with `dnf` (sudo). Part of the fingerprint. */
export const DEVELOPER_SYSTEM_PACKAGES: readonly string[] = [
  "postgresql16-server",
  "postgresql16-contrib",
  "gcc-c++",
  "make",
  // Needed to unpack the .tar.xz Node tarball; absent from the base image (found by the first live build).
  "xz",
]

/** Installed globally with the base image's npm. Part of the fingerprint. */
export const PNPM_VERSION = "10.34.5"

/**
 * A second Node line beside the base image's, unpacked to /opt/node/<version>. Pinned and checksum-verified
 * (the digest comes from nodejs.org's SHASUMS256.txt for this exact file). Part of the fingerprint.
 */
export const EXTRA_NODE = {
  version: "22.22.1",
  sha256: "9a6bc82f9b491279147219f6a18add1e18424dce90d41d2a5fcd69d4924ba3aa",
} as const

/** Where the baked, empty Postgres cluster lives. A turn copies it to a writable dir and starts it there. */
export const BAKED_PG_DIR = "/home/vercel-sandbox/pg-baked"

export function extraNodeInstallScript(): string {
  const file = `node-v${EXTRA_NODE.version}-linux-x64.tar.xz`
  return [
    "set -euo pipefail",
    'cd "$(mktemp -d)"',
    `curl -fsSL -o ${file} https://nodejs.org/dist/v${EXTRA_NODE.version}/${file}`,
    `echo "${EXTRA_NODE.sha256}  ${file}" | sha256sum -c -`,
    `sudo mkdir -p /opt/node/${EXTRA_NODE.version}`,
    `sudo tar -xJf ${file} -C /opt/node/${EXTRA_NODE.version} --strip-components=1`,
    `/opt/node/${EXTRA_NODE.version}/bin/node --version`,
  ].join("\n")
}

/** Initialises the baked cluster as the unprivileged user (initdb refuses to run as root). */
export function bakePostgresScript(): string {
  return [
    "set -euo pipefail",
    'INITDB="$(command -v initdb || ls /usr/bin/initdb /usr/pgsql-16/bin/initdb 2>/dev/null | head -1)"',
    'test -x "$INITDB"',
    `rm -rf ${BAKED_PG_DIR}`,
    `"$INITDB" -D ${BAKED_PG_DIR} --auth=trust --encoding=UTF8 --no-locale`,
  ].join("\n")
}

/**
 * Proves the layer works the way a turn will use it: copy the baked cluster, start it, query it over
 * localhost, stop it. Run before snapshotting and again after a warm boot.
 */
export function developerSmokeScript(): string {
  return [
    "set -euo pipefail",
    'PGBIN="$(dirname "$(command -v initdb || ls /usr/bin/initdb /usr/pgsql-16/bin/initdb | head -1)")"',
    'RUN="$(mktemp -d)/pgdata"',
    `cp -r ${BAKED_PG_DIR} "$RUN"`,
    'chmod 700 "$RUN"',
    '"$PGBIN/pg_ctl" -D "$RUN" -o "-c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp" -w start >/dev/null',
    'trap \'"$PGBIN/pg_ctl" -D "$RUN" -m fast stop >/dev/null\' EXIT',
    'psql -h 127.0.0.1 -U "$(whoami)" -d postgres -tAc "select version()"',
    "pnpm --version",
    `/opt/node/${EXTRA_NODE.version}/bin/node --version`,
    "node --version",
    "g++ --version | head -1",
  ].join("\n")
}

/** Bumped when the build steps change in a way the lists above cannot express. */
const DEVELOPER_RECIPE_VERSION = 1

function developerRecipe(): string {
  return JSON.stringify({
    recipeVersion: DEVELOPER_RECIPE_VERSION,
    baseFingerprint: computeDepsFingerprint(),
    systemPackages: DEVELOPER_SYSTEM_PACKAGES,
    pnpm: PNPM_VERSION,
    extraNode: EXTRA_NODE,
    bakedPgDir: BAKED_PG_DIR,
  })
}

/** SHA-256 of the DEVELOPER layer recipe, including the STANDARD fingerprint it sits on. */
export function computeDeveloperFingerprint(): string {
  return createHash("sha256").update(developerRecipe()).digest("hex")
}

export type BuildDeveloperSnapshotResult = {
  snapshotId: string
  depsFingerprint: string
  baseSnapshotId: string
  sizeBytes: number
  postgresVersion: string
  timings: { createMs: number; installMs: number; smokeMs: number; snapshotMs: number; verifyMs: number; totalMs: number }
}

function parsePostgresVersion(output: string): string {
  return output.match(/PostgreSQL (\d+(?:\.\d+)*)/)?.[1] ?? "unknown"
}

/**
 * Build the DEVELOPER snapshot on top of `baseSnapshotId`: boot the base → dnf → pnpm → extra Node → bake the
 * Postgres cluster → smoke check → snapshot → boot the result and smoke check again. Like the STANDARD build,
 * a failure here throws before anything is persisted, so the previous snapshot stays live.
 */
export async function buildDeveloperSnapshot(opts: {
  baseSnapshotId: string
  onProgress?: (line: string) => void
}): Promise<BuildDeveloperSnapshotResult> {
  const emit = opts.onProgress ?? (() => {})
  const startedAt = Date.now()
  let sandbox: Sandbox | undefined
  let snapshotted = false
  try {
    const createStart = Date.now()
    sandbox = await bootSandboxFromSnapshot(opts.baseSnapshotId, { timeoutMs: BUILD_TIMEOUT_MS })
    const createMs = Date.now() - createStart
    emit(`sandbox booted from base ${opts.baseSnapshotId}: ${sandbox.name} (${createMs}ms)`)

    const installStart = Date.now()
    await runStep(sandbox, "dnf", { cmd: "dnf", args: ["-y", "install", ...DEVELOPER_SYSTEM_PACKAGES], sudo: true }, emit)
    await runStep(sandbox, "pnpm", { cmd: "npm", args: ["install", "-g", `pnpm@${PNPM_VERSION}`], sudo: true }, emit)
    await runStep(sandbox, "node", { cmd: "bash", args: ["-c", extraNodeInstallScript()] }, emit)
    await runStep(sandbox, "pg-bake", { cmd: "bash", args: ["-c", bakePostgresScript()] }, emit)
    const installMs = Date.now() - installStart
    emit(`developer layer installed (${installMs}ms)`)

    const smokeStart = Date.now()
    const smokeOutput = await runStep(sandbox, "smoke", { cmd: "bash", args: ["-c", developerSmokeScript()] }, emit)
    const smokeMs = Date.now() - smokeStart
    const postgresVersion = parsePostgresVersion(smokeOutput)
    emit(`developer layer works: PostgreSQL ${postgresVersion} (${smokeMs}ms)`)

    const snapStart = Date.now()
    const snap = await sandbox.currentSession().snapshot()
    const snapshotMs = Date.now() - snapStart
    snapshotted = true // snapshot() stops the session; do not stop() again
    emit(`snapshot created: ${snap.snapshotId} (${snapshotMs}ms, ${snap.sizeBytes} bytes)`)

    const verifyStart = Date.now()
    await verifyDeveloperSnapshot(snap.snapshotId, emit)
    const verifyMs = Date.now() - verifyStart
    emit(`snapshot verified after warm boot (${verifyMs}ms)`)

    return {
      snapshotId: snap.snapshotId,
      depsFingerprint: computeDeveloperFingerprint(),
      baseSnapshotId: opts.baseSnapshotId,
      sizeBytes: snap.sizeBytes,
      postgresVersion,
      timings: { createMs, installMs, smokeMs, snapshotMs, verifyMs, totalMs: Date.now() - startedAt },
    }
  } finally {
    if (sandbox && !snapshotted) {
      try {
        await sandbox.stop()
      } catch {
        // best-effort cleanup
      }
    }
  }
}

async function verifyDeveloperSnapshot(snapshotId: string, emit: (line: string) => void): Promise<void> {
  const sandbox = await bootSandboxFromSnapshot(snapshotId, { timeoutMs: 3 * 60_000 })
  try {
    await runStep(sandbox, "verify", { cmd: "bash", args: ["-c", developerSmokeScript()] }, emit)
  } catch (error) {
    throw new Error(
      `snapshot ${snapshotId} was created but the developer layer does not work when booted from it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  } finally {
    try {
      await sandbox.stop()
    } catch {
      // best-effort cleanup; the sandbox timeout is the backstop
    }
  }
}
