import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { writeNativePolicyBundle } from "@/lib/native-policy-cli"
import type { NativeNowPolicyBundle } from "@/lib/native-now-policy-signing"
import { createHash } from "node:crypto"

const dirs: string[] = []
const bundle = {
  artifact: { artifactId: `now-policy:v1:sha256:${"a".repeat(64)}`, workspaceId: "00000000-0000-4000-8000-000000000001" },
  artifactSignature: "artifact-signature", selector: { workspaceId: "00000000-0000-4000-8000-000000000001" }, selectorSignature: "selector-signature",
} as unknown as NativeNowPolicyBundle

describe("native policy operator output", () => {
  afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  it("writes one complete signed bundle and an atomic active pointer and permits identical replay", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    const result = writeNativePolicyBundle(bundle, root)
    expect(JSON.parse(readFileSync(result.bundlePath, "utf8")).artifact.artifactId).toBe(bundle.artifact.artifactId)
    const activeRaw = readFileSync(result.activePath, "utf8")
    const activeDigest = `sha256:${createHash("sha256").update(activeRaw).digest("hex")}`
    expect(() => writeNativePolicyBundle(bundle, root, bundle.artifact.artifactId, activeDigest)).not.toThrow()
  })
  it("refuses to overwrite a non-identical generated artifact", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    writeNativePolicyBundle(bundle, root)
    expect(() => writeNativePolicyBundle({ ...bundle, selectorSignature: "different" }, root, bundle.artifact.artifactId)).toThrow(/collision/i)
  })
  it("rotates the active pointer only with the expected prior artifact", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    writeNativePolicyBundle(bundle, root)
    const nextId = `now-policy:v1:sha256:${"b".repeat(64)}`
    const next = { ...bundle, artifact: { ...bundle.artifact, artifactId: nextId }, selector: { ...bundle.selector, artifactId: nextId, supersedesArtifactId: bundle.artifact.artifactId } }
    expect(() => writeNativePolicyBundle(next, root, "stale-artifact")).toThrow(/CAS mismatch/)
    const activeRaw = readFileSync(join(root, bundle.artifact.workspaceId, "active.json"), "utf8")
    writeNativePolicyBundle(next, root, bundle.artifact.artifactId, `sha256:${createHash("sha256").update(activeRaw).digest("hex")}`)
    expect(JSON.parse(readFileSync(join(root, bundle.artifact.workspaceId, "active.json"), "utf8")).artifactId).toBe(nextId)
  })
  it("does not overwrite changed selector bytes merely because the artifact ID is unchanged", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    writeNativePolicyBundle(bundle, root)
    const activePath = join(root, bundle.artifact.workspaceId, "active.json")
    const expectedRaw = readFileSync(activePath, "utf8")
    const expectedDigest = `sha256:${createHash("sha256").update(expectedRaw).digest("hex")}`
    const changed = { ...JSON.parse(expectedRaw), selectorSignature: "changed-after-read" }
    writeFileSync(activePath, `${JSON.stringify(changed, null, 2)}\n`)

    expect(() => writeNativePolicyBundle(
      bundle,
      root,
      bundle.artifact.artifactId,
      expectedDigest,
    )).toThrow(/digest CAS mismatch/i)
    expect(JSON.parse(readFileSync(activePath, "utf8")).selectorSignature)
      .toBe("changed-after-read")
  })
  it("fails closed while another writer holds the exclusive workspace lock", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    const workspace = join(root, bundle.artifact.workspaceId); mkdirSync(workspace)
    writeFileSync(join(workspace, ".active.lock"), "held", { mode: 0o600 })
    expect(() => writeNativePolicyBundle(bundle, root)).toThrow(/locked/i)
  })
  it("rejects a symlinked active selector instead of following it", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    const workspace = join(root, bundle.artifact.workspaceId); mkdirSync(workspace)
    const target = join(root, "target.json"); writeFileSync(target, "{}")
    symlinkSync(target, join(workspace, "active.json"))
    expect(() => writeNativePolicyBundle(bundle, root)).toThrow(/regular file/i)
  })
  it("rejects a non-regular immutable bundle path", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "policy-cli-"))); dirs.push(root)
    const workspace = join(root, bundle.artifact.workspaceId); mkdirSync(workspace)
    mkdirSync(join(workspace, `${bundle.artifact.artifactId}.bundle.json`))
    expect(() => writeNativePolicyBundle(bundle, root)).toThrow(/regular file/i)
  })
})
