#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createRetainedCoverageManifest, normalizeRetainedLines, runVercelLogsCli, writeRetainedCoverageBundle,
  type VercelCliExportInput,
} from "../lib/vercel-retained-coverage.ts";
import type { BrowserRequest, BrowserSample } from "../lib/performance-baseline.ts";

interface ExportConfig extends VercelCliExportInput {
  projectId: string; deploymentUrl: string; sourceSha: string; safetyMarginMs: number;
}

export async function exportPerformanceVercelLogs(
  configFile: string, artifactFile: string, outputDirectory: string,
  dependencies: {
    now: () => number; wait: (milliseconds: number) => Promise<void>;
    run: Parameters<typeof runVercelLogsCli>[1];
  } = {
    now: Date.now, wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    run: undefined,
  },
): Promise<void> {
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as ExportConfig;
  const artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8")) as {
    warm?: BrowserSample[]; cold?: BrowserSample[]; samples?: BrowserSample[];
  };
  const samples = artifact.samples ?? [...(artifact.warm ?? []), ...(artifact.cold ?? [])];
  const browser = samples.flatMap((sample) => sample.requests ?? [sample]) as BrowserRequest[];
  const times = browser.map((request) => Date.parse(request.startedAt));
  if (!times.length || times.some((value) => !Number.isFinite(value)) || config.safetyMarginMs < 500) {
    throw new Error("Browser artifact cannot establish retained-log coverage bounds");
  }
  const browserMax = Math.max(...times);
  const firstExportAt = dependencies.now();
  if (firstExportAt < browserMax + 30_000) throw new Error("First retained export requires 30 seconds of browser settling");
  const first = runVercelLogsCli(config, dependencies.run);
  await dependencies.wait(15_000);
  const secondExportAt = dependencies.now();
  const second = runVercelLogsCli(config, dependencies.run);
  if (first.recordCount !== second.recordCount || normalizeRetainedLines(first.raw) !== normalizeRetainedLines(second.raw)) {
    throw new Error("Retained Vercel exports did not stabilize");
  }
  const manifest = createRetainedCoverageManifest({
    projectId: config.projectId, deploymentId: config.deploymentId, deploymentUrl: config.deploymentUrl,
    sourceSha: config.sourceSha, requestedStart: config.requestedStart, requestedEnd: config.requestedEnd,
    browserMin: new Date(Math.min(...times)).toISOString(), browserMax: new Date(Math.max(...times)).toISOString(),
    safetyMarginMs: config.safetyMarginMs, retrievedAt: new Date(secondExportAt).toISOString(), clientVersion: second.clientVersion,
    settlingDelayMs: firstExportAt - browserMax, transport: "vercel-cli-bounded", recordLimit: 10_000,
    limitNotReached: true, stabilityPasses: 2,
    exports: [
      { exportedAt: new Date(firstExportAt).toISOString(), rawSha256: createHash("sha256").update(first.raw).digest("hex"), normalizedSha256: createHash("sha256").update(normalizeRetainedLines(first.raw)).digest("hex"), recordCount: first.recordCount, timeoutMs: first.timeoutMs, exitCode: first.exitCode, warningDetected: first.warningDetected },
      { exportedAt: new Date(secondExportAt).toISOString(), rawSha256: createHash("sha256").update(second.raw).digest("hex"), normalizedSha256: createHash("sha256").update(normalizeRetainedLines(second.raw)).digest("hex"), recordCount: second.recordCount, timeoutMs: second.timeoutMs, exitCode: second.exitCode, warningDetected: second.warningDetected },
    ],
    exactDeploymentRejectionCount: 0, raw: second.raw,
  });
  writeRetainedCoverageBundle(
    path.join(outputDirectory, "vercel-retained.jsonl"),
    path.join(outputDirectory, "vercel-retained.normalized.jsonl"),
    path.join(outputDirectory, "vercel-retained.coverage.json"),
    second.raw, manifest,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [config, artifact, output] = process.argv.slice(2);
  if (!config || !artifact || !output) throw new Error("Usage: export-performance-vercel-logs.ts <config.json> <browser-artifact.json> <output-directory>");
  await exportPerformanceVercelLogs(config, artifact, output);
}
