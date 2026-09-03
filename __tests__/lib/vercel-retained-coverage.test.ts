import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRetainedCoverageManifest, normalizeRetainedLines, runVercelLogsCli, serializeExactDeploymentRecords, verifyRetainedCoverage, writeCoverageManifestAtomic, writeRetainedCoverageBundle } from "@/lib/vercel-retained-coverage";
import { createHash } from "node:crypto";

const expected = { projectId: "prj_one", deploymentId: "dpl_ABCDEFGHIJKLMNOPQRSTUVWX", deploymentUrl: "https://exact.vercel.app", sourceSha: "a".repeat(40) };
const browser = [{ requestId: "perf_inv_" + "1".repeat(32), method: "GET", path: "/roadmap", startedAt: "2026-09-03T12:00:01.000Z" }];
const raw = `${JSON.stringify({ id: "one", deploymentId: expected.deploymentId })}\n`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const manifest = () => createRetainedCoverageManifest({ ...expected, raw, requestedStart: "2026-09-03T12:00:00.000Z", requestedEnd: "2026-09-03T12:00:02.000Z", browserMin: browser[0].startedAt, browserMax: browser[0].startedAt, safetyMarginMs: 500, retrievedAt: "2026-09-03T12:01:00.000Z", clientVersion: "Vercel CLI 50.44.0", settlingDelayMs: 30_000, transport: "vercel-cli-bounded", recordLimit: 10_000, limitNotReached: true, stabilityPasses: 2, exports: [0, 1].map((index) => ({ exportedAt: `2026-09-03T12:00:${index === 0 ? "30" : "45"}.000Z`, rawSha256: digest(raw), normalizedSha256: digest(normalizeRetainedLines(raw)), recordCount: 1, timeoutMs: 60_000, exitCode: 0 as const, warningDetected: false as const })), exactDeploymentRejectionCount: 0 });

describe("retained Vercel coverage", () => {
  it("accepts exact bounded exhausted hash-verified coverage", () => {
    expect(() => verifyRetainedCoverage(manifest(), raw, browser, expected)).not.toThrow();
  });
  it.each([
    ["truncated before", { requestedStart: "2026-09-03T12:00:00.600Z" }],
    ["truncated after", { requestedEnd: "2026-09-03T12:00:01.400Z" }],
    ["transport", { transport: "unknown" }],
    ["unstable", { stabilityPasses: 1 }],
    ["rejections", { exactDeploymentRejectionCount: 1 }],
    ["hash", { rawSha256: "0".repeat(64) }],
    ["missing bounds", { browserMin: "" }],
  ])("rejects %s coverage", (_name, override) => {
    expect(() => verifyRetainedCoverage({ ...manifest(), ...override } as never, raw, browser, expected)).toThrow();
  });
  it("writes the coverage manifest atomically with owner-only permissions", () => {
    const file = path.resolve(".performance-baseline/unit-coverage.json");
    try {
      writeCoverageManifestAtomic(file, manifest());
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(manifest());
    } finally { fs.rmSync(file, { force: true }); }
  });
  it("rejects a wrong-deployment retained record", () => {
    const other = `${JSON.stringify({ id: "one", deploymentId: "dpl_other" })}\n`;
    const matchingHashes = createRetainedCoverageManifest({ ...manifest(), raw: other });
    expect(() => verifyRetainedCoverage(matchingHashes, other, browser, expected)).toThrow();
  });
  it("counts and excludes every cross-deployment record", () => {
    expect(serializeExactDeploymentRecords([
      { deploymentId: expected.deploymentId, id: "ok" },
      { deploymentId: "dpl_other", id: "wrong" },
    ], expected.deploymentId)).toEqual({
      raw: `${JSON.stringify({ deploymentId: expected.deploymentId, id: "ok" })}\n`,
      exactDeploymentRejectionCount: 1,
    });
  });
  it("uses the supported bounded Vercel CLI argument vector and accepts real envelope shape", () => {
    const calls: string[][] = [];
    const options: unknown[] = [];
    const envelope = { id: "gm98s-1788400459949-41d83ef6154b", timestamp: 1788400459949, deploymentId: expected.deploymentId, projectId: expected.projectId, source: "serverless", requestMethod: "GET", requestPath: "/acme/compass/roadmap", responseStatusCode: 200, environment: "preview", domain: "exact.vercel.app", logs: [] };
    const run = ((_command: string, args: readonly string[], spawnOptions: unknown) => {
      calls.push([...args]);
      options.push(spawnOptions);
      return { status: 0, stdout: args[0] === "--version" ? "Vercel CLI 50.44.0\n" : `${JSON.stringify(envelope)}\n`, stderr: "", pid: 1, output: [], signal: null };
    }) as never;
    const result = runVercelLogsCli({ deploymentId: expected.deploymentId, projectCwd: "/repo", scope: "rbcodelabs-team", requestedStart: "2026-09-03T12:00:00.000Z", requestedEnd: "2026-09-03T12:00:02.000Z" }, run);
    expect(calls[0]).toEqual(["logs", expected.deploymentId, "--since", "2026-09-03T12:00:00.000Z", "--until", "2026-09-03T12:00:02.000Z", "--json", "--limit", "10000", "--no-follow", "--cwd", "/repo", "--scope", "rbcodelabs-team"]);
    expect(options[0]).toEqual(expect.objectContaining({ shell: false, timeout: 60_000 }));
    expect(result).toEqual(expect.objectContaining({ recordCount: 1, timeoutMs: 60_000 }));
  });

  it.each([
    ["nonzero", { status: 1, stdout: "", stderr: "failed" }],
    ["warning", { status: 0, stdout: "", stderr: "limit reached; output truncated" }],
    ["malformed", { status: 0, stdout: "not json\n", stderr: "" }],
    ["foreign", { status: 0, stdout: `${JSON.stringify({ deploymentId: "dpl_other", source: "serverless" })}\n`, stderr: "" }],
    ["timeout signal", { status: null, signal: "SIGTERM", stdout: "", stderr: "" }],
  ])("rejects %s CLI output", (_name, first) => {
    let call = 0;
    const run = (() => call++ === 0 ? { ...first, pid: 1, output: [], signal: null } : { status: 0, stdout: "Vercel CLI 50.44.0\n", stderr: "", pid: 1, output: [], signal: null }) as never;
    expect(() => runVercelLogsCli({ deploymentId: expected.deploymentId, projectCwd: "/repo", scope: "team", requestedStart: "2026-09-03T12:00:00.000Z", requestedEnd: "2026-09-03T12:00:02.000Z" }, run)).toThrow();
  });
  it("publishes a unique private non-symlink bundle and refuses replacement", () => {
    const root = path.resolve(".performance-baseline/unit-bundle");
    fs.rmSync(root, { recursive: true, force: true });
    const files = ["raw.jsonl", "normalized.jsonl", "manifest.json"].map((name) => path.join(root, name));
    try {
      writeRetainedCoverageBundle(files[0], files[1], files[2], raw, manifest());
      expect(files.map((file) => fs.statSync(file).mode & 0o777)).toEqual([0o600, 0o600, 0o600]);
      expect(() => writeRetainedCoverageBundle(files[0], files[1], files[2], raw, manifest())).toThrow(/unique new/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
