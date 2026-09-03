#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRetainedCoverageManifest, runVercelLogsCli, writeRetainedCoverageBundle,
  type VercelCliExportInput,
} from "../lib/vercel-retained-coverage.ts";
import type { BrowserRequest, BrowserSample } from "../lib/performance-baseline.ts";

interface ExportConfig extends VercelCliExportInput {
  projectId: string; deploymentUrl: string; sourceSha: string; safetyMarginMs: number;
}

export function exportPerformanceVercelLogs(configFile: string, artifactFile: string, outputDirectory: string): void {
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
  const result = runVercelLogsCli(config);
  const manifest = createRetainedCoverageManifest({
    projectId: config.projectId, deploymentId: config.deploymentId, deploymentUrl: config.deploymentUrl,
    sourceSha: config.sourceSha, requestedStart: config.requestedStart, requestedEnd: config.requestedEnd,
    browserMin: new Date(Math.min(...times)).toISOString(), browserMax: new Date(Math.max(...times)).toISOString(),
    safetyMarginMs: config.safetyMarginMs, retrievedAt: new Date().toISOString(), clientVersion: result.clientVersion,
    settlingDelayMs: result.settlingDelayMs, recordLimit: 10_000, pageCount: 1,
    cursorExhausted: true, finalCursor: null, exactDeploymentRejectionCount: 0, raw: result.raw,
  });
  writeRetainedCoverageBundle(
    path.join(outputDirectory, "vercel-retained.jsonl"),
    path.join(outputDirectory, "vercel-retained.normalized.jsonl"),
    path.join(outputDirectory, "vercel-retained.coverage.json"),
    result.raw, manifest,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [config, artifact, output] = process.argv.slice(2);
  if (!config || !artifact || !output) throw new Error("Usage: export-performance-vercel-logs.ts <config.json> <browser-artifact.json> <output-directory>");
  exportPerformanceVercelLogs(config, artifact, output);
}
