import { request, type APIRequestContext } from "@playwright/test"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { originHeaders, signGrant, type GrantInput } from "./contracts"
import { resolveTarget } from "./resolve"

interface Options {
  operation: "bootstrap" | "session" | "revoke"
  persona?: "owner" | "viewer"
  runId: string
  expectedSha: string
  bypass: string
  privateKey: string
}
export function managedAuthOptions(args: string[], env: Record<string, string | undefined> = process.env): Options {
  const [operation, persona] = args
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
  if (env.PREVIEW_DATABASE_MODE !== "vercel-managed" || !uuid.test(env.PREVIEW_MANAGED_RUN_ID ?? "")
    || !uuid.test(env.PREVIEW_MANAGED_WORKSPACE_ID ?? "") || !/^[a-f0-9]{40}$/.test(env.PREVIEW_EXPECTED_SHA ?? "")
    || !env.PREVIEW_PROTECTION_BYPASS || !env.PREVIEW_AUTOMATION_PRIVATE_KEY) throw new Error("Managed auth configuration is incomplete")
  if (operation !== "bootstrap" && operation !== "session" && operation !== "revoke") throw new Error("Expected bootstrap, session owner|viewer, or revoke")
  if (operation === "session" ? args.length !== 2 || (persona !== "owner" && persona !== "viewer") : args.length !== 1) throw new Error("Invalid managed auth arguments")
  return { operation, ...(operation === "session" ? { persona: persona as "owner" | "viewer" } : {}), runId: env.PREVIEW_MANAGED_RUN_ID!, expectedSha: env.PREVIEW_EXPECTED_SHA!, bypass: env.PREVIEW_PROTECTION_BYPASS, privateKey: env.PREVIEW_AUTOMATION_PRIVATE_KEY }
}
interface Dependencies {
  resolve: typeof resolveTarget
  post: APIRequestContext["post"]
}
export async function runManagedAuth(options: Options, dependencies: Dependencies) {
  // Resolve again for each manual operation; never trust a saved alias or an earlier PR head.
  const target = await dependencies.resolve()
  if (target.pr !== 276 || target.sha !== options.expectedSha) throw new Error("Managed auth requires the reviewed current PR276 head")
  const operation: GrantInput["operation"] = options.operation === "revoke" ? "teardown" : options.operation
  const claims = options.persona ? { persona: options.persona } : {}
  const response = await dependencies.post(`${target.origin}/api/preview-automation/${operation}`, {
    headers: { ...originHeaders(target.origin, target.origin, options.bypass), Authorization: `Bearer ${signGrant({ deploymentId: target.deploymentId, origin: target.origin, runId: options.runId, operation, ...claims }, options.privateKey)}` },
    data: claims, maxRedirects: 0, timeout: 30_000,
  })
  if (!response.ok()) throw new Error(`Managed ${options.operation} failed (${response.status()})`)
  const bytes = await response.body()
  if (bytes.length > 16_384) throw new Error("Unexpected managed auth response")
  const body: unknown = JSON.parse(bytes.toString())
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Unexpected managed auth response")
  const result = body as Record<string, unknown>
  const base = { ...target, operation: options.operation, runId: options.runId }
  if (options.operation === "revoke") {
    if (result.runId !== options.runId || result.revoked !== true || result.retained !== true) throw new Error("Managed revocation did not confirm retained data")
    return { ...base, revoked: true, retained: true }
  }
  if (typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)) || Date.parse(result.expiresAt) <= Date.now()) throw new Error("Invalid managed session expiry")
  if (options.operation === "bootstrap") {
    if (result.runId !== options.runId || result.orgSlug !== `preview-${options.runId}` || result.workspaceSlug !== "workspace" || result.isolatedWorkspaceSlug !== "isolated") throw new Error("Unexpected managed fixture identity")
    return { ...base, orgSlug: result.orgSlug, workspaceSlug: result.workspaceSlug, isolatedWorkspaceSlug: result.isolatedWorkspaceSlug, expiresAt: result.expiresAt }
  }
  return { ...base, persona: options.persona, expiresAt: result.expiresAt }
}

async function main() {
  const options = managedAuthOptions(process.argv.slice(2))
  const context = await request.newContext()
  let directory: string | undefined
  try {
    const summary = await runManagedAuth(options, { resolve: resolveTarget, post: context.post.bind(context) })
    let stateFile: string | undefined
    if (options.operation === "session") {
      // Fresh owner-only directory; never overwrite a user path or print the cookie itself.
      directory = await mkdtemp(join(tmpdir(), "compass-managed-auth-"))
      stateFile = join(directory, `${options.persona}.json`)
      await writeFile(stateFile, JSON.stringify(await context.storageState()), { mode: 0o600, flag: "wx" })
    }
    console.log(JSON.stringify({ ...summary, ...(stateFile ? { stateFile } : {}) }))
  } catch {
    if (directory) await rm(directory, { recursive: true, force: true })
    throw new Error("Managed auth failed; inspect status before retrying. No credentials are included.")
  } finally { await context.dispose() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Managed auth failed; inspect status before retrying. No credentials are included."); process.exitCode = 1 })
}
