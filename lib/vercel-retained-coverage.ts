import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import type { BrowserRequest } from "./performance-baseline";

export interface RetainedCoverageManifest {
  schemaVersion: 1;
  projectId: string; deploymentId: string; deploymentUrl: string; sourceSha: string;
  requestedStart: string; requestedEnd: string; browserMin: string; browserMax: string;
  safetyMarginMs: number; retrievedAt: string; clientVersion: string;
  settlingDelayMs: number; transport: "vercel-cli-bounded"; recordLimit: 10000;
  limitNotReached: true; stabilityPasses: 2;
  exports: Array<{ exportedAt: string; rawSha256: string; normalizedSha256: string; recordCount: number;
    timeoutMs: number; exitCode: 0; warningDetected: false }>;
  recordCount: number; exactDeploymentRejectionCount: number;
  rawSha256: string; normalizedSha256: string;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
};
export function normalizeRetainedLines(raw: string): string {
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.stringify(canonicalize(JSON.parse(line)))).sort().join("\n") + "\n";
}

export function createRetainedCoverageManifest(input: Omit<RetainedCoverageManifest,
  "schemaVersion" | "rawSha256" | "normalizedSha256" | "recordCount"> & { raw: string }): RetainedCoverageManifest {
  const normalized = normalizeRetainedLines(input.raw);
  const { raw, ...metadata } = input;
  return {
    ...metadata,
    schemaVersion: 1,
    recordCount: normalized.split("\n").filter(Boolean).length,
    rawSha256: sha(raw), normalizedSha256: sha(normalized),
  };
}

export function writeCoverageManifestAtomic(file: string, manifest: RetainedCoverageManifest): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function verifyRetainedCoverage(
  manifest: RetainedCoverageManifest, raw: string, browser: BrowserRequest[],
  expected: { projectId: string; deploymentId: string; deploymentUrl: string; sourceSha: string },
): void {
  if (manifest.schemaVersion !== 1 || manifest.transport !== "vercel-cli-bounded" ||
      !manifest.limitNotReached || manifest.stabilityPasses !== 2 || manifest.exports.length !== 2 ||
      manifest.exports.some((item) => item.exitCode !== 0 || item.warningDetected || item.timeoutMs <= 0 ||
        Number.isNaN(Date.parse(item.exportedAt))) ||
      Date.parse(manifest.exports[1].exportedAt) - Date.parse(manifest.exports[0].exportedAt) < 15_000 ||
      new Set(manifest.exports.map((item) => `${item.normalizedSha256}:${item.recordCount}`)).size !== 1 ||
      manifest.exactDeploymentRejectionCount !== 0 ||
      manifest.exports[1]?.rawSha256 !== manifest.rawSha256 || manifest.exports[1]?.normalizedSha256 !== manifest.normalizedSha256 ||
      manifest.exports[1]?.recordCount !== manifest.recordCount ||
      manifest.recordLimit !== 10_000 || !Number.isFinite(manifest.settlingDelayMs) || manifest.settlingDelayMs < 30_000 ||
      !Number.isFinite(manifest.safetyMarginMs) || manifest.safetyMarginMs < 500 ||
      !manifest.clientVersion || Number.isNaN(Date.parse(manifest.retrievedAt)) ||
      Number.isNaN(Date.parse(manifest.requestedStart)) || Number.isNaN(Date.parse(manifest.requestedEnd)) ||
      Date.parse(manifest.requestedStart) >= Date.parse(manifest.requestedEnd) ||
      manifest.projectId !== expected.projectId || manifest.deploymentId !== expected.deploymentId ||
      manifest.deploymentUrl !== expected.deploymentUrl || manifest.sourceSha !== expected.sourceSha ||
      manifest.rawSha256 !== sha(raw) || manifest.normalizedSha256 !== sha(normalizeRetainedLines(raw)) ||
      manifest.recordCount !== raw.split(/\r?\n/).filter(Boolean).length) {
    throw new Error("Retained Vercel coverage manifest is incomplete or inconsistent");
  }
  const starts = browser.map((request) => Date.parse(request.startedAt));
  if (!starts.length || starts.some((value) => !Number.isFinite(value))) throw new Error("Browser correlation bounds are missing");
  const min = Math.min(...starts), max = Math.max(...starts);
  if (Date.parse(manifest.browserMin) !== min || Date.parse(manifest.browserMax) !== max ||
      Date.parse(manifest.requestedStart) > min - manifest.safetyMarginMs ||
      Date.parse(manifest.requestedEnd) < max + manifest.safetyMarginMs) {
    throw new Error("Retained Vercel coverage does not encompass browser correlation windows");
  }
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const value = JSON.parse(line) as { deploymentId?: unknown };
    if (value.deploymentId !== expected.deploymentId) throw new Error("Retained Vercel record has the wrong deployment");
  }
}

export interface VercelCliExportInput {
  deploymentId: string; projectCwd: string; scope: string;
  requestedStart: string; requestedEnd: string;
}

const VERCEL_LOG_TIMEOUT_MS = 60_000;

export function runVercelLogsCli(
  input: VercelCliExportInput,
  run: typeof spawnSync = spawnSync,
): { raw: string; clientVersion: string; recordCount: number; timeoutMs: number; exitCode: 0; warningDetected: false } {
  const start = Date.parse(input.requestedStart), end = Date.parse(input.requestedEnd);
  if (!/^dpl_[A-Za-z0-9]{20,64}$/.test(input.deploymentId) || !path.isAbsolute(input.projectCwd) ||
      !input.scope || !Number.isFinite(start) || !Number.isFinite(end) ||
      start >= end) throw new Error("Vercel log export identity or bounds are invalid");
  const args = ["logs", input.deploymentId, "--since", input.requestedStart, "--until", input.requestedEnd,
    "--json", "--limit", "10000", "--no-follow", "--cwd", input.projectCwd, "--scope", input.scope];
  const result = run("vercel", args, { encoding: "utf8", shell: false, timeout: VERCEL_LOG_TIMEOUT_MS }) as SpawnSyncReturns<string>;
  const stderr = result.stderr ?? "";
  const warningDetected = /truncat|limit reached|retriev(?:al|e).*warn|incomplete/i.test(stderr);
  if (result.status !== 0 || result.signal || result.error || warningDetected) {
    throw new Error("Vercel log export failed completeness gates");
  }
  const raw = result.stdout ?? "";
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length >= 10_000) throw new Error("Vercel log export reached its record limit");
  for (const line of lines) {
    let record: { deploymentId?: unknown; source?: unknown };
    try { record = JSON.parse(line) as typeof record; } catch { throw new Error("Vercel log export contains malformed JSONL"); }
    if (record.deploymentId !== input.deploymentId ||
        (record.source !== "serverless" && record.source !== "serverless-middleware")) {
      throw new Error("Vercel log export contains foreign records");
    }
  }
  const version = run("vercel", ["--version"], { encoding: "utf8", shell: false }) as SpawnSyncReturns<string>;
  if (version.status !== 0 || !version.stdout?.trim()) throw new Error("Vercel CLI version is unavailable");
  return { raw, clientVersion: version.stdout.trim(), recordCount: lines.length,
    timeoutMs: VERCEL_LOG_TIMEOUT_MS, exitCode: 0, warningDetected: false };
}

function writeAtomic(file: string, content: string): void {
  if (fs.existsSync(file)) throw new Error("Retained coverage bundle target already exists");
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function writeRetainedCoverageBundle(
  rawFile: string, normalizedFile: string, manifestFile: string,
  raw: string, manifest: RetainedCoverageManifest,
): void {
  const targets = [rawFile, normalizedFile, manifestFile];
  if (new Set(targets.map((file) => path.resolve(file))).size !== targets.length || targets.some((file) => {
    try { return fs.lstatSync(file).isSymbolicLink() || true; } catch { return false; }
  })) throw new Error("Retained coverage bundle requires unique new non-symlink targets");
  writeAtomic(rawFile, raw);
  writeAtomic(normalizedFile, normalizeRetainedLines(raw));
  writeCoverageManifestAtomic(manifestFile, manifest);
}

export function serializeExactDeploymentRecords(records: unknown[], deploymentId: string): {
  raw: string; exactDeploymentRejectionCount: number;
} {
  const accepted: unknown[] = [];
  let exactDeploymentRejectionCount = 0;
  for (const record of records) {
    if (!record || typeof record !== "object" || (record as { deploymentId?: unknown }).deploymentId !== deploymentId) {
      exactDeploymentRejectionCount += 1;
    } else accepted.push(record);
  }
  return {
    raw: accepted.map((record) => JSON.stringify(record)).join("\n") + (accepted.length ? "\n" : ""),
    exactDeploymentRejectionCount,
  };
}
