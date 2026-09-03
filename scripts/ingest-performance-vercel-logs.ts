#!/usr/bin/env node
import fs from "node:fs";
import {
  correlateVercelRequests,
  assertNoAppInvocationForCacheHits,
  extractCorrelatedBrowserRequests,
  aggregateDsqlByPlatformRequest,
  groupVercelRequestLogs,
  groupVercelEnvelopes,
  parseVercelRetainedLogs,
  type BrowserSample,
} from "../lib/performance-baseline.ts";
import { verifyRetainedCoverage, type RetainedCoverageManifest } from "../lib/vercel-retained-coverage.ts";

const [artifactPath, logsPath, coveragePath] = process.argv.slice(2);
if (!artifactPath || !logsPath || !coveragePath) {
  throw new Error("Usage: ingest-performance-vercel-logs.ts <browser-artifact.json> <vercel-logs.jsonl> <coverage-manifest.json>");
}
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
  warm?: BrowserSample[];
  cold?: BrowserSample[];
  samples?: BrowserSample[];
  buildSha?: string; deploymentId?: string; deploymentUrl?: string; projectId?: string;
};
const browserSamples = artifact.samples ?? [...(artifact.warm ?? []), ...(artifact.cold ?? [])];
const rawLogs = fs.readFileSync(logsPath, "utf8");
const lines = rawLogs.split(/\r?\n/).filter(Boolean);
if (!artifact.buildSha || !artifact.deploymentId || !artifact.deploymentUrl || !artifact.projectId) {
  throw new Error("Browser artifact is missing immutable preview deployment metadata");
}
const coverage = JSON.parse(fs.readFileSync(coveragePath, "utf8")) as RetainedCoverageManifest;
verifyRetainedCoverage(coverage, rawLogs, browserSamples.flatMap((sample) => sample.requests ?? [sample]), {
  sourceSha: artifact.buildSha, deploymentId: artifact.deploymentId,
  deploymentUrl: artifact.deploymentUrl, projectId: artifact.projectId,
});
const { requests: rawRequests, queryEnvelopes, schemaPath } = parseVercelRetainedLogs(lines);
const { requests: browserRequests, cacheHits, cdnCacheHits } = extractCorrelatedBrowserRequests(browserSamples);
const logs = groupVercelRequestLogs(rawRequests);
const invocationLogs = groupVercelEnvelopes(
  logs,
  queryEnvelopes,
  browserRequests.map((request) => request.requestId!),
);
const correlated = correlateVercelRequests(browserRequests, invocationLogs);
assertNoAppInvocationForCacheHits(cdnCacheHits, logs);
const durations = correlated.flatMap(({ vercel }) => vercel.durationMs === null ? [] : [vercel.durationMs]).sort((a, b) => a - b);
const dsql = aggregateDsqlByPlatformRequest(correlated.map(({ vercel }) => vercel.requestId), queryEnvelopes);
const percentile = (p: number) => durations[Math.ceil(durations.length * p) - 1] ?? null;
process.stdout.write(JSON.stringify({
  version: 1,
  retainedLogSchemaPath: schemaPath,
  requestCount: correlated.length,
  serverDurationAvailableCount: durations.length,
  totalServerDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
  medianServerDurationMs: percentile(0.5),
  p95ServerDurationMs: percentile(0.95),
  dsql,
  cacheHits: [...cacheHits, ...cdnCacheHits].map((sample) => ({ ...sample, serverDurationMs: null, dsql: null })),
  requests: correlated.map(({ browser, vercel }) => ({
    customRequestId: browser.requestId,
    platformRequestId: vercel.requestId,
    method: vercel.method,
    path: vercel.path,
    statusCode: vercel.statusCode,
    serverDurationMs: vercel.durationMs,
  })),
}, null, 2) + "\n");
