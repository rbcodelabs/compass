#!/usr/bin/env node
import fs from "node:fs";
import {
  correlateVercelRequests,
  aggregateDsqlByRequest,
  groupVercelEnvelopes,
  parseVercelRequestLog,
  parseVercelQueryEnvelope,
  type BrowserRequest,
} from "../lib/performance-baseline.ts";

const [artifactPath, logsPath] = process.argv.slice(2);
if (!artifactPath || !logsPath) {
  throw new Error("Usage: ingest-performance-vercel-logs.ts <browser-artifact.json> <vercel-logs.jsonl>");
}
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as {
  warm?: BrowserRequest[];
  cold?: BrowserRequest[];
  samples?: BrowserRequest[];
};
const browserSamples = artifact.samples ?? [...(artifact.warm ?? []), ...(artifact.cold ?? [])];
const lines = fs.readFileSync(logsPath, "utf8").split(/\r?\n/).filter(Boolean);
const queryEnvelopes = lines.map(parseVercelQueryEnvelope).filter((entry): entry is NonNullable<typeof entry> => entry !== null);
const rawRequests = lines
  .map(parseVercelRequestLog)
  .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
const networkedSamples = browserSamples.filter((sample) => !("networkOutcome" in sample) || !String(sample.networkOutcome).startsWith("router-cache"));
const cacheHits = browserSamples.filter((sample) => "networkOutcome" in sample && String(sample.networkOutcome).startsWith("router-cache"));
const measuredIds = networkedSamples.map((request) => request.requestId);
const logs = groupVercelEnvelopes(rawRequests, queryEnvelopes, measuredIds);
const correlated = correlateVercelRequests(networkedSamples, logs);
const durations = correlated.map(({ vercel }) => vercel.durationMs).sort((a, b) => a - b);
const dsql = aggregateDsqlByRequest(measuredIds, queryEnvelopes);
for (const id of measuredIds) if (!dsql.some((entry) => entry.customRequestId === id)) throw new Error(`Measured sample ${id} has no DSQL query records`);
for (const match of correlated) {
  const groups = dsql.filter((entry) => entry.customRequestId === match.browser.requestId);
  if (groups.length !== 1 || groups[0].platformRequestId !== match.vercel.requestId) throw new Error(`DSQL records for ${match.browser.requestId} do not match its selected platform request`);
}
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
