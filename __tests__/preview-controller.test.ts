import { describe, expect, it } from "vitest"
import { validateDeployment, schemaFor, originHeaders, signGrant } from "../scripts/preview-automation/contracts"
import { generateKeyPairSync, verify } from "node:crypto"

const sha = "a".repeat(40)
const deployment = { id: "dpl_abc", url: "compass-abc-team.vercel.app", projectId: "prj_compass", readyState: "READY", target: null, meta: { githubCommitSha: sha, githubCommitOrg: "rbcodelabs", githubCommitRepo: "compass", githubPrId: "123" } }
const pr = { number: 123, state: "open", head: { sha, repo: { full_name: "rbcodelabs/compass" } }, base: { repo: { full_name: "rbcodelabs/compass" } } }
describe("preview controller trust boundaries", () => {
  it("binds an immutable ready deployment to current first-party PR head", () => {
    expect(validateDeployment(deployment, pr, "prj_compass").schema).toBe(`compass_pr_123_${sha.slice(0,12)}`)
  })
  it.each([
    { ...deployment, target: "production" },
    { ...deployment, projectId: "prj_other" },
    { ...deployment, url: "https://evil.example" },
    { ...deployment, meta: { ...deployment.meta, githubCommitSha: "b".repeat(40) } },
  ])("rejects an untrusted deployment", d => expect(() => validateDeployment(d, pr, "prj_compass")).toThrow())
  it("rejects forks and closed PRs", () => {
    expect(() => validateDeployment(deployment, { ...pr, head: { ...pr.head, repo: { full_name: "evil/compass" } } }, "prj_compass")).toThrow()
    expect(() => validateDeployment(deployment, { ...pr, state: "closed" }, "prj_compass")).toThrow()
  })
  it("never turns arbitrary branch text into SQL identifiers", () => expect(() => schemaFor("1; DROP SCHEMA public", sha)).toThrow())
  it("never forwards bypass headers cross-origin", () => {
    expect(originHeaders("https://safe.vercel.app", "https://evil.example/x", "secret")).toEqual({})
    expect(originHeaders("https://safe.vercel.app", "https://safe.vercel.app/x", "secret")).toEqual({ "x-vercel-protection-bypass": "secret" })
  })
  it("signs a short-lived deployment/run-bound grant", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const token = signGrant({ deploymentId: "dpl_abc", origin: "https://safe.vercel.app", runId: "92c79bbe-0122-40f4-80bf-cad9a305d567", operation: "bootstrap" }, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), 1000)
    const [payload, signature] = token.split(".")
    expect(verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, "base64url"))).toBe(true)
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({ iat: 1000, exp: 1300, operation: "bootstrap" })
  })
})
