import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parsePreviewFixtureOrchestrationArgs, validatePreviewFixtureResponse } from "@/scripts/run-preview-performance-fixture";
import { previewFixtureIdentityDigest } from "@/lib/preview-performance-fixture";

const common = [
  "--run-id", `perf_preview_${"a".repeat(32)}`,
  "--deployment-sha", "b".repeat(40),
  "--deployment-id", `dpl_${"C".repeat(24)}`,
  "--deployment-url", "https://compass-abc123-rbcodelabs-team.vercel.app/",
];

describe("preview fixture HTTPS orchestration", () => {
  it("accepts only preflight, seed, cleanup, and verify with bounded expiry", () => {
    expect(parsePreviewFixtureOrchestrationArgs(["seed", ...common, "--expires-minutes", "20"])).toMatchObject({ command: "seed", expiresMinutes: 20 });
    expect(parsePreviewFixtureOrchestrationArgs(["cleanup", ...common])).toMatchObject({ command: "cleanup" });
    expect(parsePreviewFixtureOrchestrationArgs(["verify", ...common])).toMatchObject({ command: "verify" });
    const preflight = parsePreviewFixtureOrchestrationArgs(["preflight", ...common.slice(2)]);
    expect(preflight).toMatchObject({ command: "preflight", expiresMinutes: 5 });
    expect(preflight.runId).toMatch(/^perf_preview_[a-f0-9]{32}$/);
    expect(() => parsePreviewFixtureOrchestrationArgs(["seed", ...common, "--expires-minutes", "31"])).toThrow(/15 through 30/);
    expect(() => parsePreviewFixtureOrchestrationArgs(["seed", ...common, "--session-token", "secret"])).toThrow(/Unknown/);
  });

  it("contains no direct AWS, OIDC, Prisma, or DSQL connector path", () => {
    const source = fs.readFileSync("scripts/run-preview-performance-fixture.ts", "utf8");
    for (const forbidden of ["@aws-sdk", "awsCredentialsProvider", "PrismaClient", "DsqlSigner", "PGHOST"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it.each(["performance:preview-preflight", "performance:preview-seed", "performance:preview-cleanup", "performance:preview-verify"])(
    "loads the actual %s package script under Node strip-types",
    (script) => {
      const result = spawnSync("pnpm", [script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } });
      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain(script.endsWith("preflight") ? "Missing --deployment-sha" : "Missing --run-id");
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_MODULE_NOT_FOUND/);
    },
  );

  it("strictly validates action-specific token-free responses", () => {
    expect(validatePreviewFixtureResponse("seed", { state: "seeded", residue: 1231, replayed: false })).toEqual({ state: "seeded", residue: 1231, replayed: false });
    expect(validatePreviewFixtureResponse("cleanup", { state: "absent", residue: 0 })).toEqual({ state: "absent", residue: 0 });
    expect(validatePreviewFixtureResponse("verify", { state: "absent", residue: 0 })).toEqual({ state: "absent", residue: 0 });
    for (const invalid of [
      { state: "seeded", residue: 0 },
      { state: "absent", residue: 0, token: "secret" },
      { state: "absent", residue: "0" },
      { state: "other", residue: 0 },
    ]) expect(() => validatePreviewFixtureResponse("verify", invalid)).toThrow(/response/);
  });

  it("strictly validates the preflight proof and independently bound digest", () => {
    const expectedDigest = "a".repeat(64);
    const response = {
      state: "ready",
      checks: { preview: true, schema: true, sha: true, deployment: true, host: true, oidc: true, secret: true },
      identityDigest: expectedDigest,
    };
    expect(validatePreviewFixtureResponse("preflight", response, expectedDigest)).toEqual(response);
    for (const invalid of [
      { ...response, identityDigest: "b".repeat(64) },
      { ...response, checks: { ...response.checks, oidc: false } },
      { ...response, extra: true },
      { ...response, identityDigest: `${expectedDigest}token` },
    ]) expect(() => validatePreviewFixtureResponse("preflight", invalid, expectedDigest)).toThrow(/response/);
  });

  it("binds the identity digest to every versioned tuple component", () => {
    const identity = {
      runId: `perf_preview_${"1".repeat(32)}`,
      deploymentSha: "2".repeat(40),
      deploymentId: `dpl_${"A".repeat(24)}`,
      deploymentUrl: "compass-digest-rbcodelabs-team.vercel.app",
    };
    const digest = previewFixtureIdentityDigest(identity);
    for (const changed of [
      { ...identity, runId: `perf_preview_${"3".repeat(32)}` },
      { ...identity, deploymentSha: "4".repeat(40) },
      { ...identity, deploymentId: `dpl_${"B".repeat(24)}` },
      { ...identity, deploymentUrl: "compass-other-rbcodelabs-team.vercel.app" },
    ]) expect(previewFixtureIdentityDigest(changed)).not.toBe(digest);
  });

  it("uses the explicitly verified deployment URL for manifest and cookie state", async () => {
    const { buildDeterministicPreviewFixturePlan, createPreviewFixtureAuthState } = await import("@/lib/preview-performance-fixture");
    const plan = buildDeterministicPreviewFixturePlan({
      runId: `perf_preview_${"d".repeat(32)}`,
      deploymentSha: "e".repeat(40),
      deploymentId: `dpl_${"F".repeat(24)}`,
      deploymentUrl: "https://compass-explicit-rbcodelabs-team.vercel.app/",
      expiresAt: new Date(Date.now() + 20 * 60_000),
      sessionToken: "s".repeat(64),
    });
    expect(plan.identity.deploymentUrl).toBe("https://compass-explicit-rbcodelabs-team.vercel.app/");
    const state = createPreviewFixtureAuthState(plan) as { cookies: Array<{ domain: string }> };
    expect(state.cookies[0].domain).toBe("compass-explicit-rbcodelabs-team.vercel.app");
  });
});
