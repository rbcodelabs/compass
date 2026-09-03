import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createRetainedCoverageManifest, exportRetainedVercelLogs, fetchAllRetainedPages, serializeExactDeploymentRecords, verifyRetainedCoverage, writeCoverageManifestAtomic } from "@/lib/vercel-retained-coverage";

const expected = { projectId: "prj_one", deploymentId: "dpl_ABCDEFGHIJKLMNOPQRSTUVWX", deploymentUrl: "https://exact.vercel.app", sourceSha: "a".repeat(40) };
const browser = [{ requestId: "perf_inv_" + "1".repeat(32), method: "GET", path: "/roadmap", startedAt: "2026-09-03T12:00:01.000Z" }];
const raw = `${JSON.stringify({ id: "one", deploymentId: expected.deploymentId })}\n`;
const manifest = () => createRetainedCoverageManifest({ ...expected, raw, requestedStart: "2026-09-03T12:00:00.000Z", requestedEnd: "2026-09-03T12:00:02.000Z", browserMin: browser[0].startedAt, browserMax: browser[0].startedAt, safetyMarginMs: 500, retrievedAt: "2026-09-03T12:01:00.000Z", clientVersion: "vercel-api-v1/50.44.0", pageCount: 2, cursorExhausted: true, finalCursor: null, exactDeploymentRejectionCount: 0 });

describe("retained Vercel coverage", () => {
  it("accepts exact bounded exhausted hash-verified coverage", () => {
    expect(() => verifyRetainedCoverage(manifest(), raw, browser, expected)).not.toThrow();
  });
  it.each([
    ["truncated before", { requestedStart: "2026-09-03T12:00:00.600Z" }],
    ["truncated after", { requestedEnd: "2026-09-03T12:00:01.400Z" }],
    ["pagination", { cursorExhausted: false }],
    ["remaining cursor", { finalCursor: "more" }],
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
    expect(() => verifyRetainedCoverage(matchingHashes, other, browser, expected)).toThrow(/wrong deployment/);
  });
  it("fully paginates and rejects a repeated or unexhausted cursor", async () => {
    const result = await fetchAllRetainedPages(async (cursor) => cursor === null
      ? { records: [1], nextCursor: "two" } : { records: [2], nextCursor: null });
    expect(result).toEqual({ records: [1, 2], pageCount: 2, cursorExhausted: true, finalCursor: null });
    await expect(fetchAllRetainedPages(async () => ({ records: [], nextCursor: "same" }))).rejects.toThrow(/cursor/);
    await expect(fetchAllRetainedPages(async () => ({ records: [], nextCursor: crypto.randomUUID() }), 1)).rejects.toThrow(/not exhausted/);
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
  it("passes exact immutable bounds and identity through every export page", async () => {
    const input = { projectId: expected.projectId, deploymentId: expected.deploymentId, requestedStart: "2026-09-03T12:00:00.000Z", requestedEnd: "2026-09-03T12:00:02.000Z" };
    const seen: unknown[] = [];
    const result = await exportRetainedVercelLogs(input, async (request) => {
      seen.push(request);
      return request.cursor === null
        ? { records: [{ deploymentId: expected.deploymentId }], nextCursor: "next" }
        : { records: [], nextCursor: null };
    });
    expect(seen).toEqual([{ ...input, cursor: null }, { ...input, cursor: "next" }]);
    expect(result.cursorExhausted).toBe(true);
  });
});
