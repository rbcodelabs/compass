#!/usr/bin/env node
import fs from "node:fs";
import {
  correlateVercelRequests,
  extractCorrelatedBrowserRequests,
  aggregateDsqlByPlatformRequest,
  groupVercelRequestLogs,
  parseVercelRequestLog,
  parseVercelQueryEnvelopes,
  assertVercelPreviewLogContext,
  type BrowserSample,
} from "../lib/performance-baseline.ts";

const [artifactPath, logsPath] = process.argv.slice(2);
if (!artifactPath || !logsPath) {
  throw new Error("Usage: ingest-performance-vercel-logs.ts <browser-artifact.json> <vercel-logs.jsonl>");
}
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
  warm?: BrowserSample[];
  cold?: BrowserSample[];
  samples?: BrowserSample[];
};
const browserSamples = artifact.samples ?? [...(artifact.warm ?? []), ...(artifact.cold ?? [])];
const lines = fs.readFileSync(logsPath, "utf8").split(/\r?\n/).filter(Boolean);
const queryEnvelopes = lines.flatMap(parseVercelQueryEnvelopes);
const rawRequests = lines
  .map(parseVercelRequestLog)
  .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
const { requests: browserRequests, cacheHits } = extractCorrelatedBrowserRequests(browserSamples);
const logs = groupVercelRequestLogs(rawRequests);
assertVercelPreviewLogContext(logs);
const correlated = correlateVercelRequests(browserRequests, logs);
const durations = correlated.flatMap(({ vercel }) => vercel.durationMs === null ? [] : [vercel.durationMs]).sort((a, b) => a - b);
const dsql = aggregateDsqlByPlatformRequest(correlated.map(({ vercel }) => vercel.requestId), queryEnvelopes);
const percentile = (p: number) => durations[Math.ceil(durations.length * p) - 1] ?? null;
process.stdout.write(JSON.stringify({
  version: 1,
  requestCount: correlated.length,
  serverDurationAvailableCount: durations.length,
  totalServerDurationMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null,
  medianServerDurationMs: percentile(0.5),
  p95ServerDurationMs: percentile(0.95),
  dsql,
  cacheHits: cacheHits.map((sample) => ({ ...sample, serverDurationMs: null, dsql: null })),
  requests: correlated.map(({ browser, vercel }) => ({
    customRequestId: browser.requestId,
    platformRequestId: vercel.requestId,
    method: vercel.method,
    path: vercel.path,
    statusCode: vercel.statusCode,
    serverDurationMs: vercel.durationMs,
  })),
}, null, 2) + "\n");
