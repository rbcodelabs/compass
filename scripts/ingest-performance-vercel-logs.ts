#!/usr/bin/env node
import fs from "node:fs";
import {
  correlateVercelRequests,
  extractCorrelatedBrowserRequests,
  aggregateDsqlByPlatformRequest,
  groupVercelRequestLogs,
  parseVercelRequestLog,
  parseVercelQueryEnvelope,
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
const queryEnvelopes = lines.map(parseVercelQueryEnvelope).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
const rawRequests = lines
  .map(parseVercelRequestLog)
  .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
const { requests: browserRequests, cacheHits } = extractCorrelatedBrowserRequests(browserSamples);
const logs = groupVercelRequestLogs(rawRequests);
const correlated = correlateVercelRequests(browserRequests, logs);
const durations = correlated.map(({ vercel }) => vercel.durationMs).sort((a, b) => a - b);
const dsql = aggregateDsqlByPlatformRequest(correlated.map(({ vercel }) => vercel.requestId), queryEnvelopes);
const percentile = (p: number) => durations[Math.ceil(durations.length * p) - 1] ?? null;
process.stdout.write(JSON.stringify({
  version: 1,
  requestCount: correlated.length,
  totalServerDurationMs: durations.reduce((sum, value) => sum + value, 0),
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
