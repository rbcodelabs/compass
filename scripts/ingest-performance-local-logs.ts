#!/usr/bin/env node
import fs from "node:fs";
import { aggregateQueryEvents, parsePerformanceQueryLog, type BrowserRequest } from "../lib/performance-baseline";

const [artifactPath, logPath] = process.argv.slice(2);
if (!artifactPath || !logPath) throw new Error("Usage: ingest-performance-local-logs.ts <artifact.json> <server.log>");
const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as { warm?: BrowserRequest[]; cold?: BrowserRequest[]; samples?: BrowserRequest[] };
const samples = artifact.samples ?? [...(artifact.warm ?? []), ...(artifact.cold ?? [])];
const events = fs.readFileSync(logPath, "utf8").split(/\r?\n/).map(parsePerformanceQueryLog).filter((event): event is NonNullable<typeof event> => event !== null);
const queries = samples.map((sample) => {
  const matching = events.filter((event) => event.requestId === sample.requestId);
  if (!matching.length && !("networkOutcome" in sample && sample.networkOutcome === "router-cache-hit")) throw new Error(`Measured request ${sample.requestId} has no local query records`);
  const byFingerprint = [...new Set(matching.map((event) => event.fingerprint))].map((fingerprint) => ({ fingerprint, ...aggregateQueryEvents(matching.filter((event) => event.fingerprint === fingerprint)) }));
  return { requestId: sample.requestId, ...aggregateQueryEvents(matching), fingerprints: byFingerprint };
});
process.stdout.write(JSON.stringify({ version: 1, samples, queries }, null, 2) + "\n");
