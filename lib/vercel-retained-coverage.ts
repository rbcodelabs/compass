import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserRequest } from "./performance-baseline";

export interface RetainedCoverageManifest {
  schemaVersion: 1;
  projectId: string; deploymentId: string; deploymentUrl: string; sourceSha: string;
  requestedStart: string; requestedEnd: string; browserMin: string; browserMax: string;
  safetyMarginMs: number; retrievedAt: string; clientVersion: string;
  pageCount: number; cursorExhausted: boolean; finalCursor: null;
  recordCount: number; exactDeploymentRejectionCount: number;
  rawSha256: string; normalizedSha256: string;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function normalizeRetainedLines(raw: string): string {
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.stringify(JSON.parse(line))).sort().join("\n") + "\n";
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
  if (manifest.schemaVersion !== 1 || !manifest.cursorExhausted || manifest.finalCursor !== null ||
      manifest.pageCount < 1 || manifest.exactDeploymentRejectionCount !== 0 ||
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

export async function fetchAllRetainedPages(
  fetchPage: (cursor: string | null) => Promise<{ records: unknown[]; nextCursor: string | null }>,
  maxPages = 1_000,
): Promise<{ records: unknown[]; pageCount: number; cursorExhausted: true; finalCursor: null }> {
  const records: unknown[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let pageCount = 1; pageCount <= maxPages; pageCount++) {
    const page = await fetchPage(cursor);
    records.push(...page.records);
    if (page.nextCursor === null) return { records, pageCount, cursorExhausted: true, finalCursor: null };
    if (seen.has(page.nextCursor)) throw new Error("Vercel retained export cursor did not advance");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Vercel retained export pagination was not exhausted");
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

export async function exportRetainedVercelLogs(
  input: { projectId: string; deploymentId: string; requestedStart: string; requestedEnd: string },
  fetchPage: (request: typeof input & { cursor: string | null }) => Promise<{ records: unknown[]; nextCursor: string | null }>,
) {
  const start = Date.parse(input.requestedStart), end = Date.parse(input.requestedEnd);
  if (!input.projectId || !/^dpl_[A-Za-z0-9]{20,64}$/.test(input.deploymentId) ||
      !Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Vercel retained export bounds or deployment identity are invalid");
  }
  const pages = await fetchAllRetainedPages((cursor) => fetchPage({ ...input, cursor }));
  return { ...pages, ...serializeExactDeploymentRecords(pages.records, input.deploymentId) };
}
