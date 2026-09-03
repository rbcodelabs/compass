import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { createHash, createPrivateKey } from "node:crypto"
import { generateSignedNativeNowPolicyBundle, type NativeNowPolicyBundle } from "@/lib/native-now-policy-signing"

export class NativePolicyCliError extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const stableJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function writeIdenticalOrNew(path: string, content: string) {
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new NativePolicyCliError(`Output path is not a regular file: ${path}.`)
    if (readFileSync(path, "utf8") === content) return
    throw new NativePolicyCliError(`Output collision at ${path}.`)
  }
  const temporary = `${path}.tmp-${process.pid}`
  try { writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); renameSync(temporary, path); chmodSync(path, 0o644) }
  catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error }
}

function readRegularFile(path: string): string {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) throw new NativePolicyCliError(`Policy path is not a regular file: ${path}.`)
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const content = readFileSync(descriptor, "utf8")
    const after = lstatSync(path)
    if (before.dev !== after.dev || before.ino !== after.ino) throw new NativePolicyCliError("Policy path changed while locked.")
    return content
  } finally { closeSync(descriptor) }
}

function fsyncDirectory(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

export function writeNativePolicyBundle(bundle: NativeNowPolicyBundle, outputRoot: string, expectedActiveArtifactId: string | null = null, expectedActiveSelectorDigest: string | null = null) {
  const root = resolve(outputRoot)
  if (existsSync(root) && (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())) throw new NativePolicyCliError("Output root must be a real directory.")
  mkdirSync(root, { recursive: true })
  if (realpathSync(root) !== root) throw new NativePolicyCliError("Output root must not contain symlink components.")
  const workspaceDir = join(root, bundle.artifact.workspaceId)
  mkdirSync(workspaceDir, { recursive: true })
  if (lstatSync(workspaceDir).isSymbolicLink() || !lstatSync(workspaceDir).isDirectory() || realpathSync(workspaceDir) !== workspaceDir) throw new NativePolicyCliError("Workspace policy directory must be a real directory.")
  const bundlePath = join(workspaceDir, `${bundle.artifact.artifactId}.bundle.json`)
  const activePath = join(workspaceDir, "active.json"), lockPath = join(workspaceDir, ".active.lock")
  if (existsSync(lockPath)) {
    const lockStat = lstatSync(lockPath)
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) throw new NativePolicyCliError("Active selector lock path is not a regular file.")
  }
  let lock: number
  try { lock = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600) }
  catch { throw new NativePolicyCliError("Active selector is locked by another writer.") }
  try {
    writeFileSync(lock, stableJson({ pid: process.pid, acquiredAt: new Date().toISOString() }))
    fsyncSync(lock)
    const activeRaw = existsSync(activePath) ? readRegularFile(activePath) : null
    const active = activeRaw ? JSON.parse(activeRaw) as { artifactId?: string } : null
    const currentId = active?.artifactId ?? null
    // Validate the immutable content-addressed artifact before considering a
    // pointer replay; the same artifact ID must never name different bytes.
    writeIdenticalOrNew(bundlePath, stableJson(bundle))
    if (currentId !== expectedActiveArtifactId) throw new NativePolicyCliError("Active selector CAS mismatch.")
    const actualDigest = activeRaw ? `sha256:${createHash("sha256").update(activeRaw).digest("hex")}` : null
    if (actualDigest !== expectedActiveSelectorDigest) throw new NativePolicyCliError("Active selector digest CAS mismatch.")
    if (currentId && currentId !== bundle.artifact.artifactId && bundle.selector.supersedesArtifactId !== currentId) throw new NativePolicyCliError("Signed selector does not supersede the active artifact.")
    const pointer = stableJson({ schemaVersion: "compass-now-policy-active/v1", workspaceId: bundle.artifact.workspaceId, artifactId: bundle.artifact.artifactId, bundlePath: `${bundle.artifact.artifactId}.bundle.json`, selector: bundle.selector, selectorSignature: bundle.selectorSignature })
    if (!existsSync(activePath) || readRegularFile(activePath) !== pointer) {
      const temporary = `${activePath}.tmp-${process.pid}`
      try {
        writeFileSync(temporary, pointer, { encoding: "utf8", flag: "wx", mode: 0o600 })
        const temporaryDescriptor = openSync(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        try { fsyncSync(temporaryDescriptor) } finally { closeSync(temporaryDescriptor) }
        renameSync(temporary, activePath); chmodSync(activePath, 0o644); fsyncDirectory(workspaceDir)
      } catch (error) { if (existsSync(temporary)) unlinkSync(temporary); throw error }
    }
    return { bundlePath, activePath }
  } finally {
    closeSync(lock)
    unlinkSync(lockPath)
    fsyncDirectory(workspaceDir)
  }
}

function argumentsMap(argv: string[]) {
  const result = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1]
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new NativePolicyCliError("Every option requires one value.")
    if (result.has(key)) throw new NativePolicyCliError(`Duplicate option ${key}.`)
    result.set(key, value)
  }
  return result
}

export async function runNativePolicyCli(argv: string[]) {
  const args = argumentsMap(argv)
  const workspaceId = args.get("--workspace-id"), activationDecisionId = args.get("--activation-decision-id")
  const routingFingerprint = args.get("--routing-fingerprint"), mode = args.get("--mode")
  const generatedAt = args.get("--generated-at"), validUntil = args.get("--valid-until"), outputDir = args.get("--output-dir")
  const signingKeyId = args.get("--signing-key-id"), configuredSigningKeyId = process.env.NOW_DECISION_SIGNING_KEY_ID, keyPath = process.env.NOW_DECISION_SIGNING_KEY_FILE
  const expectedActive = args.get("--expected-active-artifact-id")
  const expectedActiveDigest = args.get("--expected-active-selector-digest")
  if (!workspaceId || !UUID.test(workspaceId) || !activationDecisionId || !UUID.test(activationDecisionId)
    || !["shadow", "enforce"].includes(mode ?? "") || !generatedAt || !Number.isFinite(Date.parse(generatedAt))
    || !outputDir || !signingKeyId || !configuredSigningKeyId || signingKeyId !== configuredSigningKeyId
    || !keyPath || expectedActive === undefined || expectedActiveDigest === undefined) throw new NativePolicyCliError("Required bounded signing inputs are missing, invalid, or use an unexpected signing key ID.")
  const stat = lstatSync(keyPath)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new NativePolicyCliError("Signing key file must be a regular file with mode 0600.")
  const privateKey = createPrivateKey(readFileSync(keyPath))
  const priorArtifactId = expectedActive === "none" ? null : expectedActive
  const priorSelectorDigest = expectedActiveDigest === "none" ? null : expectedActiveDigest
  if ((priorArtifactId === null) !== (priorSelectorDigest === null) || (priorSelectorDigest !== null && !/^sha256:[0-9a-f]{64}$/i.test(priorSelectorDigest))) throw new NativePolicyCliError("Expected active artifact and selector digest must identify the same prior state.")
  const effectiveValidUntil = validUntil ?? new Date(Date.parse(generatedAt) + 14 * 24 * 60 * 60_000).toISOString()
  const bundle = await generateSignedNativeNowPolicyBundle(workspaceId, activationDecisionId, { signingKeyId, privateKey, routingFingerprint: routingFingerprint ?? "", mode: mode as "shadow" | "enforce", generatedAt, validUntil: effectiveValidUntil, supersedesArtifactId: priorArtifactId })
  return writeNativePolicyBundle(bundle, outputDir, priorArtifactId, priorSelectorDigest)
}
