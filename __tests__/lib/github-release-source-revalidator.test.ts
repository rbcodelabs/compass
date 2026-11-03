import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/db", () => ({ default: () => ({}) }))
vi.mock("@/lib/decision-service", () => ({ recordDecision: vi.fn() }))

import { createGitHubReleaseSourceRevalidator, releasePoliciesFromEnv } from "@/lib/github-release-source-revalidator"
import { releaseSourceFingerprint, type ReleaseScope } from "@/lib/release-authorization"

const HEAD = "a".repeat(40)
const scope: ReleaseScope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  provider: "GITHUB",
  repositoryOwner: "acme",
  repositoryName: "compass",
  pullRequestNumber: 7,
  baseRef: "main",
  headSha: HEAD,
  targetEnvironment: "PRODUCTION",
  releasePolicyId: "default",
  taskIds: ["22222222-2222-4222-8222-222222222222"],
}

type Overrides = { pr?: Record<string, unknown>; runs?: unknown[]; statuses?: unknown[]; failUrl?: string }

function setup(o: Overrides = {}, policies = releasePoliciesFromEnv('{"default":{"requiredChecks":["build"]}}')) {
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (o.failUrl && u.includes(o.failUrl)) return new Response("nope", { status: 500 })
    if (u.includes("/pulls/")) {
      return Response.json({ state: "open", draft: false, merged: false, mergeable: true, base: { ref: "main" }, head: { sha: HEAD }, ...o.pr })
    }
    if (u.includes("/check-runs")) {
      const runs = o.runs ?? [{ name: "build", status: "completed", conclusion: "success" }]
      return Response.json({ total_count: runs.length, check_runs: runs })
    }
    return Response.json({ statuses: o.statuses ?? [] })
  })
  const mintToken = vi.fn(async () => ({ token: "tok" }))
  const revalidator = createGitHubReleaseSourceRevalidator({ fetcher: fetcher as unknown as typeof fetch, mintToken, policies })
  return { revalidator, fetcher, mintToken }
}

describe("GitHub release source revalidator", () => {
  it("returns VALID with the unchanged fingerprint when the PR and checks are green", async () => {
    const { revalidator, mintToken } = setup()
    const result = await revalidator.revalidate(scope)
    expect(result).toEqual({ status: "VALID", snapshot: { scope, fingerprint: releaseSourceFingerprint(scope) } })
    expect(mintToken).toHaveBeenCalledWith(expect.objectContaining({ permissions: expect.not.arrayContaining(["contents:write", "pull_requests:write"]) }))
  })

  it.each([
    ["closed PR", { pr: { state: "closed" } }],
    ["merged PR", { pr: { merged: true } }],
    ["draft PR", { pr: { draft: true } }],
    ["changed base", { pr: { base: { ref: "develop" } } }],
    ["moved head", { pr: { head: { sha: "b".repeat(40) } } }],
    ["conflicts", { pr: { mergeable: false } }],
  ])("blocks PR_NOT_READY on %s", async (_name, o) => {
    const result = await setup(o as Overrides).revalidator.revalidate(scope)
    expect(result).toMatchObject({ status: "BLOCKED", code: "PR_NOT_READY" })
  })

  it("blocks CHECKS_FAILED on a failing, pending, missing or absent check", async () => {
    for (const runs of [
      [{ name: "build", status: "completed", conclusion: "failure" }],
      [{ name: "build", status: "in_progress", conclusion: null }],
      [{ name: "lint", status: "completed", conclusion: "success" }],
      [],
    ]) {
      expect(await setup({ runs }).revalidator.revalidate(scope)).toMatchObject({ status: "BLOCKED", code: "CHECKS_FAILED" })
    }
  })

  it("blocks when any non-required check or commit status is failing", async () => {
    const runs = [{ name: "build", status: "completed", conclusion: "success" }]
    expect(await setup({ runs, statuses: [{ context: "ci/other", state: "failure" }] }).revalidator.revalidate(scope))
      .toMatchObject({ status: "BLOCKED", code: "CHECKS_FAILED" })
  })

  it("blocks POLICY_CHANGED for an unknown policy without calling GitHub", async () => {
    const { revalidator, fetcher, mintToken } = setup({}, releasePoliciesFromEnv(undefined))
    expect(await revalidator.revalidate(scope)).toMatchObject({ status: "BLOCKED", code: "POLICY_CHANGED" })
    expect(fetcher).not.toHaveBeenCalled()
    expect(mintToken).not.toHaveBeenCalled()
  })

  it("rejects (fail closed) when GitHub errors", async () => {
    await expect(setup({ failUrl: "/pulls/" }).revalidator.revalidate(scope)).rejects.toThrow("GitHub request failed (500)")
  })

  it("ignores malformed policy configuration", () => {
    expect(releasePoliciesFromEnv("not json")("default")).toBeNull()
    expect(releasePoliciesFromEnv('{"default":{}}')("default")).toEqual({ requiredChecks: [] })
  })
})
