import { describe, expect, it, vi } from "vitest"
import { generateKeyPairSync, verify } from "node:crypto"
import { managedAuthOptions, runManagedAuth } from "../scripts/preview-automation/managed-auth"

const runId = "92c79bbe-0122-40f4-80bf-cad9a305d567"
const workspaceId = "82c79bbe-0122-40f4-80bf-cad9a305d567"
const sha = "a".repeat(40)
const { privateKey, publicKey } = generateKeyPairSync("ed25519")
const env = { PREVIEW_DATABASE_MODE: "vercel-managed", PREVIEW_MANAGED_RUN_ID: runId, PREVIEW_MANAGED_WORKSPACE_ID: workspaceId, PREVIEW_EXPECTED_SHA: sha, PREVIEW_PROTECTION_BYPASS: "synthetic-bypass", PREVIEW_AUTOMATION_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() }
const target = { deploymentId: "dpl_test", origin: "https://compass-unique.vercel.app", schema: `compass_pr_276_${sha.slice(0, 12)}`, sha, pr: 276 }
function dependencies(body: object) {
  return { resolve: vi.fn().mockResolvedValue(target), post: vi.fn().mockResolvedValue({ ok: () => true, status: () => 200, body: async () => Buffer.from(JSON.stringify(body)) }) }
}
describe("manual managed pilot auth", () => {
  it.each([{}, { ...env, PREVIEW_DATABASE_MODE: "scoped-role" }, { ...env, PREVIEW_MANAGED_RUN_ID: "" }, { ...env, PREVIEW_EXPECTED_SHA: "main" }])("rejects invalid configuration before requests", input => {
    expect(() => managedAuthOptions(["bootstrap"], input)).toThrow()
  })
  it.each([[["cleanup"]], [["session"]], [["bootstrap", "extra"]], [["session", "admin"]]])("rejects unsupported arguments %s", args => {
    expect(() => managedAuthOptions(args, env)).toThrow()
  })
  it("uses the fixed run, signed bootstrap and bounded non-redirecting request", async () => {
    const deps = dependencies({ runId, orgSlug: `preview-${runId}`, workspaceSlug: "workspace", isolatedWorkspaceSlug: "isolated", expiresAt: new Date(Date.now() + 3600000).toISOString() })
    const result = await runManagedAuth(managedAuthOptions(["bootstrap"], env), deps)
    expect(result).toMatchObject({ runId, operation: "bootstrap", schema: target.schema })
    const [url, request] = deps.post.mock.calls[0]
    expect(url).toBe(`${target.origin}/api/preview-automation/bootstrap`)
    expect(request).toMatchObject({ timeout: 30000, maxRedirects: 0, data: {}, headers: { "x-vercel-protection-bypass": "synthetic-bypass" } }) // gitleaks:allow synthetic fixture, never a credential
    const [payload, signature] = request.headers.Authorization.slice(7).split(".")
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url"))).toBe(true)
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ runId, operation: "bootstrap", deploymentId: target.deploymentId })
  })
  it.each([{ ...target, pr: 277 }, { ...target, sha: "b".repeat(40) }])("rejects a different PR or head before signing/request", async wrong => {
    const deps = dependencies({}); deps.resolve.mockResolvedValue(wrong)
    await expect(runManagedAuth(managedAuthOptions(["bootstrap"], env), deps)).rejects.toThrow()
    expect(deps.post).not.toHaveBeenCalled()
  })
  it("echoes the signed session persona and never returns session secrets", async () => {
    const deps = dependencies({ expiresAt: new Date(Date.now() + 100000).toISOString(), sessionToken: "never-output" })
    const result = await runManagedAuth(managedAuthOptions(["session", "viewer"], env), deps)
    expect(deps.post.mock.calls[0][1].data).toEqual({ persona: "viewer" })
    expect(JSON.stringify(result)).not.toContain("never-output")
  })
  it("maps revoke to retained managed teardown without physical cleanup", async () => {
    const deps = dependencies({ runId, revoked: true, retained: true })
    expect(await runManagedAuth(managedAuthOptions(["revoke"], env), deps)).toMatchObject({ revoked: true, retained: true })
    expect(deps.post.mock.calls[0][0]).toBe(`${target.origin}/api/preview-automation/teardown`)
  })
  it("fails closed on cleanup-shaped teardown responses", async () => {
    await expect(runManagedAuth(managedAuthOptions(["revoke"], env), dependencies({ runId, revoked: true, retained: false }))).rejects.toThrow()
  })
  it("does not echo errors, follow redirects, or retry uncertain requests", async () => {
    const deps = dependencies({ secret: "private" })
    deps.post.mockResolvedValue({ ok: () => false, status: () => 409 })
    await expect(runManagedAuth(managedAuthOptions(["bootstrap"], env), deps)).rejects.toThrow("Managed bootstrap failed (409)")
    expect(deps.post).toHaveBeenCalledTimes(1)
  })
})
