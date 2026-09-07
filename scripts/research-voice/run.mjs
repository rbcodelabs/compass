import { build } from "esbuild"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { packageProbeWorker } from "./build.ts"

if (process.versions.node.split(".")[0] !== "22") throw new Error("Probe requires Node22")
const mode = process.argv[2]
if (!["--check", "--live-approved"].includes(mode)) throw new Error("Use --check; live execution requires separately approved --live-approved")
const directory = mkdtempSync(join(tmpdir(), "compass-voice-probe-"))
try {
  const worker = join(directory, "worker.cjs")
  writeFileSync(worker, await packageProbeWorker(), { mode: 0o600 })
  const smoke = spawnSync(process.execPath, [worker, "--self-test"], { timeout: 5000, encoding: "utf8", env: { PATH: process.env.PATH } })
  if (smoke.status !== 0 || smoke.stdout.trim() !== "PROBE_WORKER_LOADED") throw new Error("Packaged worker failed Node22 preflight")
  const controller = join(directory, "probe.cjs")
  await build({ entryPoints: [fileURLToPath(new URL("./probe.ts", import.meta.url))], outfile: controller,
    bundle: true, platform: "node", target: "node22", format: "cjs", packages: "external", logLevel: "silent" })
  const result = spawnSync(process.execPath, [controller, mode, directory], {
    stdio: "inherit", env: { ...process.env, NODE_PATH: resolve("node_modules") }, timeout: 150_000,
  })
  process.exitCode = result.status ?? 1
} finally { rmSync(directory, { recursive: true }) }
