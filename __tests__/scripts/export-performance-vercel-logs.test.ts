import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportPerformanceVercelLogs } from "../../scripts/export-performance-vercel-logs";

describe("stable Vercel retained export", () => {
  it("waits for browser settling and requires two identical exports at least 15 seconds apart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "compass-vercel-export-"));
    const deploymentId = `dpl_${"A".repeat(24)}`;
    const config = path.join(root, "config.json"), artifact = path.join(root, "artifact.json"), output = path.join(root, "output");
    fs.writeFileSync(config, JSON.stringify({ projectId: "prj_one", deploymentId, deploymentUrl: "https://exact.vercel.app", sourceSha: "a".repeat(40), safetyMarginMs: 500, projectCwd: "/repo", scope: "team", requestedStart: "2026-09-03T11:59:59.500Z", requestedEnd: "2026-09-03T12:00:00.500Z" }));
    fs.writeFileSync(artifact, JSON.stringify({ samples: [{ requestId: "perf", method: "GET", path: "/roadmap", startedAt: "2026-09-03T12:00:00.000Z" }] }));
    const envelope = JSON.stringify({ id: "one", timestamp: 1788436800000, deploymentId, source: "serverless" });
    let clock = Date.parse("2026-09-03T12:00:30.000Z");
    const waits: number[] = [];
    const run = ((_command: string, args: readonly string[]) => ({ status: 0, signal: null, stderr: "", pid: 1, output: [], stdout: args[0] === "--version" ? "Vercel CLI 50.44.0\n" : `${envelope}\n` })) as never;
    try {
      await exportPerformanceVercelLogs(config, artifact, output, { now: () => clock, wait: async (milliseconds) => { waits.push(milliseconds); clock += milliseconds; }, run });
      const manifest = JSON.parse(fs.readFileSync(path.join(output, "vercel-retained.coverage.json"), "utf8"));
      expect(waits).toEqual([15_000]);
      expect(manifest).toEqual(expect.objectContaining({ transport: "vercel-cli-bounded", stabilityPasses: 2, limitNotReached: true }));
      expect(manifest.exports).toHaveLength(2);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
