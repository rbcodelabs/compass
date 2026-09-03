import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PERFORMANCE_QUERY_PREFIX = "COMPASS_PERF_QUERY ";
const WRAPPED = Symbol.for("compass.performanceBaseline.wrapped");
const QUERY_OBSERVATION = new AsyncLocalStorage<boolean>();
const OWNED_PERFORMANCE_SCHEMA_PATTERN = /^compass_perf_[a-z0-9_]+$/;

export function persistPerformanceArtifact(
  serverKind: "local-production" | "vercel-preview",
  name: string,
  artifact: unknown,
  root = path.resolve(".performance-baseline")
): string {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Performance artifact name is invalid");
  const artifactPath = path.join(root, `${serverKind}-${name}.json`);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(artifactPath, 0o600);
  return artifactPath;
}

export function initializeLocalPerformanceEnvironment(env: NodeJS.ProcessEnv): void {
  env.PERF_SERVER_KIND = "local-production";
  env.PERF_EXTERNALLY_MANAGED = "1";
  env.COMPASS_PERF_BASELINE = "1";
}

/** Prisma 7.8 removed the historical --skip-generate db-push option. */
export function prismaPerformanceDbPushArgs(): string[] {
  return ["prisma", "db", "push"];
}

export function createLocalPerformanceChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  baseURL: string
): NodeJS.ProcessEnv {
  const url = new URL(baseURL);
  if (url.protocol !== "http:" || (url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) {
    throw new Error("Local performance AUTH_URL must be an exact loopback HTTP origin");
  }
  const childEnv: NodeJS.ProcessEnv = { ...baseEnv, AUTH_URL: url.origin };
  delete childEnv.AUTH_TRUST_HOST;
  return childEnv;
}

export interface PerformanceQueryEvent {
  version: 1;
  timestamp: string;
  requestId: string | null;
  operation: string;
  fingerprint: string;
  durationMs: number;
  success: boolean;
  rowCount: number | null;
  errorCode?: string;
}

type QueryResult = { rowCount?: number | null };
type QueryTarget = {
  query: (...args: unknown[]) => unknown;
  [WRAPPED]?: boolean;
};
type PoolTarget = QueryTarget & {
  connect: (...args: unknown[]) => unknown;
};

function queryText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "text" in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }
  return "";
}

function operationOf(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toUpperCase().replace(/[^A-Z]/g, "") || "UNKNOWN";
}

/**
 * Returns a stable SHA-256 shape identifier. Raw or normalized SQL is never
 * emitted because comments and uncommon literal syntaxes can contain secrets.
 */
export function normalizeQueryFingerprint(
  sql: string,
  ownedPerformanceSchema = process.env.COMPASS_PERF_SCHEMA
): string {
  if (ownedPerformanceSchema !== undefined && !OWNED_PERFORMANCE_SCHEMA_PATTERN.test(ownedPerformanceSchema)) {
    throw new Error("Query fingerprint schema must be an owned performance schema");
  }
  let shape = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\$[A-Za-z_][A-Za-z0-9_]*\$[\s\S]*?\$[A-Za-z_][A-Za-z0-9_]*\$/g, "?")
    .replace(/'(?:''|[^'])*'/g, "?");
  if (ownedPerformanceSchema) {
    shape = shape
      .replaceAll(`"${ownedPerformanceSchema}"`, '"__compass_owned_performance_schema__"')
      .replace(
        new RegExp(`(?<![A-Za-z0-9_$])${ownedPerformanceSchema}(?![A-Za-z0-9_$])`, "g"),
        "__compass_owned_performance_schema__"
      );
  }
  shape = shape
    .replace(/\$\d+/g, "?")
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return createHash("sha256").update(shape).digest("hex");
}

export function assertSafeLocalPerformanceDatabase(
  databaseUrl: string,
  schema: string
): void {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Performance database URL is invalid");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Performance fixtures require a loopback database host");
  }
  if (decodeURIComponent(url.pathname).replace(/^\//, "") !== "compass") {
    throw new Error("Performance fixtures require the compass database");
  }
  if (!OWNED_PERFORMANCE_SCHEMA_PATTERN.test(schema)) {
    throw new Error("Performance schema must be an owned compass_perf_* schema");
  }
}

function wrapQueryTarget(
  target: QueryTarget,
  emit: (event: PerformanceQueryEvent) => void,
  now: () => number,
  requestId: () => string | null | Promise<string | null>
): void {
  if (target[WRAPPED]) return;
  const original = target.query.bind(target);
  Object.defineProperty(target, WRAPPED, { value: true });
  target.query = (...args: unknown[]) => {
    if (QUERY_OBSERVATION.getStore()) return original(...args);
    const sql = queryText(args[0]);
    const start = now();
    const capturedRequestId = requestId();
    const complete = (success: boolean, result?: QueryResult, error?: unknown) => {
      const event = (id: string | null): PerformanceQueryEvent => ({
        version: 1,
        timestamp: new Date().toISOString(),
        requestId: id,
        operation: operationOf(sql),
        fingerprint: normalizeQueryFingerprint(sql),
        durationMs: Math.max(0, now() - start),
        success,
        rowCount: success && typeof result?.rowCount === "number" ? result.rowCount : null,
        ...(success
          ? {}
          : { errorCode: error instanceof Error ? error.name : "UnknownError" }),
      });
      const id = capturedRequestId;
      if (id && typeof (id as PromiseLike<string | null>).then === "function") {
        void Promise.resolve(id).then((resolved) => emit(event(resolved)));
      } else {
        emit(event(id as string | null));
      }
    };
    try {
      const callbackIndex = args.length - 1;
      const callback =
        callbackIndex >= 0 && typeof args[callbackIndex] === "function"
          ? (args[callbackIndex] as (error: unknown, result?: QueryResult) => void)
          : null;
      if (callback) {
        args[callbackIndex] = (error: unknown, result?: QueryResult) => {
          complete(!error, result, error);
          callback(error, result);
        };
        return QUERY_OBSERVATION.run(true, () => original(...args));
      }
      const returned = QUERY_OBSERVATION.run(true, () => original(...args));
      if (returned && typeof (returned as PromiseLike<QueryResult>).then === "function") {
        return Promise.resolve(returned).then(
          (result) => {
            complete(true, result);
            return result;
          },
          (error) => {
            complete(false, undefined, error);
            throw error;
          }
        );
      }
      if (
        returned &&
        typeof returned === "object" &&
        !("rowCount" in returned) &&
        typeof (returned as { on?: unknown }).on === "function"
      ) {
        throw new Error("Streaming pg queries are unsupported by the performance observer");
      }
      complete(true, returned as QueryResult);
      return returned;
    } catch (error) {
      complete(false, undefined, error);
      throw error;
    }
  };
}

/**
 * Instruments public Pool.query calls and explicitly checked-out clients.
 * pg's internal Pool.query path does not call the public connect method; the
 * symbol guard also prevents a returned client from being wrapped twice.
 */
export function instrumentPgPool(
  pool: PoolTarget,
  emit: (event: PerformanceQueryEvent) => void,
  now: () => number = performance.now.bind(performance),
  requestId: () => string | null | Promise<string | null> =
    () => process.env.COMPASS_PERF_REQUEST_ID ?? null
): void {
  wrapQueryTarget(pool, emit, now, requestId);
  const originalConnect = pool.connect.bind(pool);
  pool.connect = (...args: unknown[]) => {
    const callbackIndex = args.length - 1;
    const callback =
      callbackIndex >= 0 && typeof args[callbackIndex] === "function"
        ? (args[callbackIndex] as (error: unknown, client?: QueryTarget, done?: () => void) => void)
        : null;
    if (callback) {
      args[callbackIndex] = (error: unknown, client?: QueryTarget, done?: () => void) => {
        if (!error && client) wrapQueryTarget(client, emit, now, requestId);
        callback(error, client, done);
      };
      return originalConnect(...args);
    }
    const returned = originalConnect(...args);
    if (returned && typeof (returned as PromiseLike<QueryTarget>).then === "function") {
      return Promise.resolve(returned as PromiseLike<QueryTarget>).then((client) => {
        wrapQueryTarget(client, emit, now, requestId);
        return client;
      });
    }
    const client = returned as QueryTarget;
    wrapQueryTarget(client, emit, now, requestId);
    return client;
  };
}

export function formatPerformanceQueryLog(event: PerformanceQueryEvent): string {
  return PERFORMANCE_QUERY_PREFIX + JSON.stringify(event);
}

export function parsePerformanceQueryLog(line: string): PerformanceQueryEvent | null {
  const index = line.indexOf(PERFORMANCE_QUERY_PREFIX);
  if (index < 0) return null;
  try {
    const value = JSON.parse(line.slice(index + PERFORMANCE_QUERY_PREFIX.length)) as Partial<PerformanceQueryEvent>;
    if (
      value.version !== 1 ||
      typeof value.timestamp !== "string" ||
      (value.requestId !== null && typeof value.requestId !== "string") ||
      typeof value.operation !== "string" ||
      !/^[A-Z]+$/.test(value.operation) ||
      typeof value.fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      typeof value.durationMs !== "number" ||
      !Number.isFinite(value.durationMs) ||
      value.durationMs < 0 ||
      typeof value.success !== "boolean" ||
      (value.rowCount !== null && (!Number.isInteger(value.rowCount) || value.rowCount! < 0)) ||
      Number.isNaN(Date.parse(value.timestamp))
    ) return null;
    return value as PerformanceQueryEvent;
  } catch {
    return null;
  }
}

export function aggregateQueryEvents(events: PerformanceQueryEvent[]) {
  const durations = events.map((event) => event.durationMs).sort((a, b) => a - b);
  const quantile = (p: number) =>
    durations.length ? durations[Math.ceil(p * durations.length) - 1] : null;
  return {
    count: events.length,
    failedCount: events.filter((event) => !event.success).length,
    totalDurationMs: durations.reduce((sum, duration) => sum + duration, 0),
    maxDurationMs: durations.length ? durations[durations.length - 1] : null,
    p50DurationMs: quantile(0.5),
    p95DurationMs: quantile(0.95),
  };
}

export function correlateQueryEvents(
  requestIds: string[],
  events: PerformanceQueryEvent[]
): Map<string, PerformanceQueryEvent[]> {
  const expected = new Set(requestIds);
  const grouped = new Map(requestIds.map((id) => [id, [] as PerformanceQueryEvent[]]));
  for (const event of events) {
    if (!event.requestId || !expected.has(event.requestId)) continue;
    grouped.get(event.requestId)!.push(event);
  }
  return grouped;
}

export function assertSafeAuthState(authPath: string, repositoryRoot = process.cwd()): void {
  const allowed = path.resolve(repositoryRoot, "e2e/performance/.auth");
  const resolved = path.resolve(authPath);
  if (resolved !== allowed && !resolved.startsWith(allowed + path.sep)) {
    throw new Error("Performance auth state must be under e2e/performance/.auth");
  }
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Performance auth state must be a regular non-symlink file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Performance auth state must be owner-only (mode 600)");
  }
  try {
    execFileSync("git", ["check-ignore", "-q", resolved], { cwd: repositoryRoot });
  } catch {
    throw new Error("Performance auth state must be git-ignored");
  }
}

export interface BrowserRequest {
  requestId: string;
  method: string;
  path: string;
  startedAt: string;
}

export type BrowserSample = BrowserRequest & {
  requests?: BrowserRequest[];
  networkOutcome?: string;
};

export function resolvePerformanceInvocationId(sampleId: string | null, vercelRequestId: string | null): string | null {
  if (!sampleId) return null;
  if (!vercelRequestId) return sampleId;
  return `perf_inv_${createHash("sha256").update(`${sampleId}\0${vercelRequestId}`).digest("hex")}`;
}

export function extractCorrelatedBrowserRequests(samples: BrowserSample[]) {
  const cacheHits = samples.filter((sample) => sample.networkOutcome?.startsWith("router-cache"));
  const requests = samples
    .filter((sample) => !sample.networkOutcome?.startsWith("router-cache"))
    .flatMap((sample) => sample.requests ?? [sample]);
  const ids = requests.map((request) => request.requestId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Browser performance requests must have unique correlation IDs");
  }
  return { requests, cacheHits };
}
export interface VercelRequest {
  requestId: string;
  customRequestId: string;
  method: string;
  path: string;
  timestamp: string;
  durationMs: number | null;
  statusCode: number;
  deploymentId?: string;
  projectId?: string;
  source?: string;
  environment?: string;
  domain?: string;
}

export function parseVercelRequestLog(line: string): VercelRequest | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const request = (raw.request && typeof raw.request === "object"
      ? raw.request
      : raw) as Record<string, unknown>;
    const response = (raw.response && typeof raw.response === "object"
      ? raw.response
      : raw) as Record<string, unknown>;
    const proxy = (raw.proxy && typeof raw.proxy === "object" ? raw.proxy : {}) as Record<string, unknown>;
    const headers = (request.headers && typeof request.headers === "object"
      ? request.headers
      : {}) as Record<string, unknown>;
    const rawTimestamp = raw.timestamp ?? raw.time;
    const timestamp = typeof rawTimestamp === "number"
      ? new Date(rawTimestamp < 10_000_000_000 ? rawTimestamp * 1_000 : rawTimestamp).toISOString()
      : String(rawTimestamp ?? "");
    const functionInfo = (raw.function && typeof raw.function === "object" ? raw.function : {}) as Record<string, unknown>;
    const value = {
      requestId: String(raw.id ?? raw.requestId ?? raw.request_id ?? ""),
      customRequestId: String(headers["x-compass-perf-request-id"] ?? raw.customRequestId ?? ""),
      method: String(request.method ?? proxy.method ?? raw.requestMethod ?? raw.method ?? ""),
      path: String(raw.requestPath ?? request.path ?? request.url ?? raw.path ?? ""),
      timestamp,
      durationMs: functionInfo.durationMs !== undefined || functionInfo.duration !== undefined || raw.durationMs !== undefined || raw.duration !== undefined
        ? Number(functionInfo.durationMs ?? functionInfo.duration ?? raw.durationMs ?? raw.duration)
        : null,
      statusCode: Number(response.statusCode ?? response.status ?? raw.responseStatusCode ?? raw.statusCode ?? raw.status ?? NaN),
      deploymentId: typeof raw.deploymentId === "string" ? raw.deploymentId : undefined,
      projectId: typeof raw.projectId === "string" ? raw.projectId : undefined,
      source: typeof raw.source === "string" ? raw.source : undefined,
      environment: typeof raw.environment === "string" ? raw.environment : undefined,
      domain: typeof raw.domain === "string" ? raw.domain : undefined,
    };
    if (
      !value.requestId ||
      !/^[A-Z]+$/.test(value.method) ||
      !value.path.startsWith("/") ||
      Number.isNaN(Date.parse(value.timestamp)) ||
      (value.durationMs !== null && (!Number.isFinite(value.durationMs) || value.durationMs < 0)) ||
      !Number.isInteger(value.statusCode)
    ) return null;
    return value;
  } catch {
    return null;
  }
}

export function parseVercelQueryEnvelope(line: string): { platformRequestId: string; event: PerformanceQueryEvent } | null {
  return parseVercelQueryEnvelopes(line)[0] ?? null;
}

export function parseVercelQueryEnvelopes(line: string): Array<{ platformRequestId: string; event: PerformanceQueryEvent }> {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const platformRequestId = String(raw.id ?? raw.requestId ?? raw.request_id ?? "");
    if (!platformRequestId) return [];
    const nested = Array.isArray(raw.logs) ? raw.logs : [];
    const messages = [raw, ...nested].flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (!entry || typeof entry !== "object") return [];
      const record = entry as Record<string, unknown>;
      const message = typeof record.message === "string" ? record.message : typeof record.msg === "string" ? record.msg : "";
      return message ? [message] : [];
    });
    return messages.flatMap((message) => {
      const event = parsePerformanceQueryLog(message);
      return event ? [{ platformRequestId, event }] : [];
    });
  } catch { return []; }
}

export function parseVercelRetainedLogs(lines: string[]): {
  schemaPath: "observed-cli-metadata" | "legacy";
  requests: VercelRequest[];
  queryEnvelopes: Array<{ platformRequestId: string; event: PerformanceQueryEvent }>;
} {
  const parsed = lines.flatMap((line) => {
    try { return [{ line, raw: JSON.parse(line) as Record<string, unknown> }]; }
    catch { return []; }
  });
  const observed = parsed.filter(({ raw }) =>
    typeof raw.id === "string" &&
    ["deploymentId", "projectId", "source", "environment", "domain"].some((key) => raw[key] !== undefined));
  if (observed.length === 0) {
    return {
      schemaPath: "legacy",
      requests: lines.map(parseVercelRequestLog).filter((request): request is VercelRequest => request !== null),
      queryEnvelopes: lines.flatMap(parseVercelQueryEnvelopes),
    };
  }
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
  const grouped = new Map<string, typeof observed>();
  for (const item of observed) {
    const id = String(item.raw.id);
    grouped.set(id, [...(grouped.get(id) ?? []), item]);
  }
  const unique = [...grouped.entries()].map(([id, candidates]) => {
    if (new Set(candidates.map(({ raw }) => canonical(raw))).size !== 1) {
      throw new Error(`Platform request ${id} has conflicting retained envelopes`);
    }
    return candidates[0].line;
  });
  const requests = unique.map(parseVercelRequestLog).filter((request): request is VercelRequest => request !== null);
  if (requests.length !== unique.length) throw new Error("Observed Vercel CLI envelope is invalid");
  assertVercelPreviewLogContext(requests);
  return { schemaPath: "observed-cli-metadata", requests, queryEnvelopes: unique.flatMap(parseVercelQueryEnvelopes) };
}

export function assertVercelPreviewLogContext(requests: VercelRequest[]): void {
  const fields = requests.flatMap((request) => [request.deploymentId, request.projectId, request.source, request.environment, request.domain]);
  if (fields.every((field) => field === undefined)) return;
  const complete = requests.every((request) => request.deploymentId && request.projectId && request.source && request.environment && request.domain);
  const consistent = (key: "deploymentId" | "projectId" | "source" | "environment" | "domain") =>
    new Set(requests.map((request) => request[key])).size === 1;
  if (
    !complete ||
    !consistent("deploymentId") || !consistent("projectId") || !consistent("source") || !consistent("environment") || !consistent("domain") ||
    requests[0]?.source !== "serverless" || requests[0]?.environment !== "preview" ||
    !/^[a-z0-9-]+\.vercel\.app$/.test(requests[0]?.domain ?? "")
  ) throw new Error("Vercel retained log context is incomplete or inconsistent");
}

export function aggregateDsqlByRequest(measuredCustomIds: string[], envelopes: Array<{ platformRequestId: string; event: PerformanceQueryEvent }>) {
  const measured = new Set(measuredCustomIds);
  const customIdsByPlatform = new Map<string, Set<string>>();
  for (const envelope of envelopes) {
    if (!envelope.event.requestId) continue;
    const ids = customIdsByPlatform.get(envelope.platformRequestId) ?? new Set<string>();
    ids.add(envelope.event.requestId);
    customIdsByPlatform.set(envelope.platformRequestId, ids);
  }
  for (const [platformId, ids] of customIdsByPlatform) {
    if (ids.size !== 1) throw new Error(`Platform request ${platformId} has inconsistent Compass request IDs`);
  }
  const grouped = new Map<string, typeof envelopes>();
  for (const envelope of envelopes) {
    if (!envelope.event.requestId || !measured.has(envelope.event.requestId)) continue;
    const key = envelope.event.requestId + "::" + envelope.platformRequestId;
    grouped.set(key, [...(grouped.get(key) ?? []), envelope]);
  }
  return [...grouped.entries()].map(([key, values]) => {
    const [customRequestId, platformRequestId] = key.split("::");
    const events = values.map(({ event }) => event);
    const fingerprints = [...new Set(events.map((event) => event.fingerprint))].sort().map((fingerprint) => ({ fingerprint, ...aggregateQueryEvents(events.filter((event) => event.fingerprint === fingerprint)) }));
    return { customRequestId, platformRequestId, ...aggregateQueryEvents(events), fingerprints };
  });
}

export function groupVercelEnvelopes(requests: VercelRequest[], queries: Array<{ platformRequestId: string; event: PerformanceQueryEvent }>, measuredCustomIds: string[]) {
  const measured = new Set(measuredCustomIds);
  const queryByPlatform = new Map<string, typeof queries>();
  for (const query of queries) queryByPlatform.set(query.platformRequestId, [...(queryByPlatform.get(query.platformRequestId) ?? []), query]);
  const grouped = new Map<string, VercelRequest[]>();
  for (const request of requests) grouped.set(request.requestId, [...(grouped.get(request.requestId) ?? []), request]);
  return [...grouped.entries()].flatMap(([platformRequestId, candidates]) => {
    const queryEvents = queryByPlatform.get(platformRequestId) ?? [];
    const ids = new Set(queryEvents.map(({ event }) => event.requestId).filter(Boolean));
    const measuredIds = [...ids].filter((id) => measured.has(id!));
    if (measuredIds.length === 0) return [];
    if (ids.size !== 1 || measuredIds.length !== 1) throw new Error(`Platform request ${platformRequestId} must have exactly one measured Compass request ID`);
    const customRequestId = measuredIds[0]!;
    const signatures = new Set(candidates.map((item) => `${item.method} ${item.path} ${item.statusCode}`));
    if (signatures.size !== 1) throw new Error(`Platform request ${platformRequestId} has inconsistent invocation records`);
    const timings = new Set(candidates.map((item) => `${item.timestamp} ${item.durationMs}`));
    if (timings.size !== 1) throw new Error(`Platform request ${platformRequestId} has inconsistent authoritative timing`);
    return [{ ...candidates[0], customRequestId, queryEvents }];
  });
}

export function groupVercelRequestLogs(requests: VercelRequest[]): VercelRequest[] {
  const grouped = new Map<string, VercelRequest[]>();
  for (const request of requests) grouped.set(request.requestId, [...(grouped.get(request.requestId) ?? []), request]);
  return [...grouped.entries()].map(([platformRequestId, candidates]) => {
    const signatures = new Set(candidates.map((item) => JSON.stringify([
      item.method, item.path, item.statusCode, item.timestamp, item.durationMs,
      item.deploymentId ?? null, item.projectId ?? null, item.source ?? null,
      item.environment ?? null, item.domain ?? null,
    ])));
    if (signatures.size !== 1) throw new Error(`Platform request ${platformRequestId} has inconsistent invocation records`);
    return candidates[0];
  });
}

export function aggregateDsqlByPlatformRequest(
  selectedPlatformIds: string[],
  envelopes: Array<{ platformRequestId: string; event: PerformanceQueryEvent }>,
) {
  if (new Set(selectedPlatformIds).size !== selectedPlatformIds.length) {
    throw new Error("Selected platform request IDs must be one-to-one with browser requests");
  }
  const selected = new Set(selectedPlatformIds);
  const grouped = new Map<string, typeof envelopes>();
  for (const envelope of envelopes) {
    if (!selected.has(envelope.platformRequestId)) continue;
    grouped.set(envelope.platformRequestId, [...(grouped.get(envelope.platformRequestId) ?? []), envelope]);
  }
  return selectedPlatformIds.map((platformRequestId) => {
    const values = grouped.get(platformRequestId) ?? [];
    if (values.length === 0) throw new Error(`Selected platform request ${platformRequestId} has no DSQL query records`);
    const ids = new Set(values.map(({ event }) => event.requestId).filter((id): id is string => Boolean(id)));
    if (ids.size !== 1 || values.some(({ event }) => !event.requestId)) {
      throw new Error(`Platform request ${platformRequestId} has inconsistent Compass request IDs`);
    }
    const events = values.map(({ event }) => event);
    const fingerprints = [...new Set(events.map((event) => event.fingerprint))].sort().map((fingerprint) => ({
      fingerprint,
      ...aggregateQueryEvents(events.filter((event) => event.fingerprint === fingerprint)),
    }));
    return { customRequestId: [...ids][0], platformRequestId, ...aggregateQueryEvents(events), fingerprints };
  });
}

export function summarizeObserverOverhead(disabledMs: number[], enabledMs: number[]) {
  if (!disabledMs.length || disabledMs.length !== enabledMs.length) throw new Error("Observer overhead samples must be non-empty and paired");
  const summary = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] };
  };
  const disabled = summary(disabledMs), enabled = summary(enabledMs);
  return { version: 1, sampleCount: disabledMs.length, disabled, enabled, medianDeltaMs: enabled.medianMs - disabled.medianMs, p95DeltaMs: enabled.p95Ms - disabled.p95Ms };
}

export function resolvePerformanceResourceSampleId(
  headerSampleId: string | null,
  activeSampleId: string | null
): string | null {
  if (!activeSampleId) return null;
  if (headerSampleId && activeSampleId && headerSampleId !== activeSampleId) {
    throw new Error(
      `Resource sample ID ${headerSampleId} conflicts with active sample ${activeSampleId}`
    );
  }
  return headerSampleId ?? activeSampleId;
}

export function correlateVercelRequests(
  browser: BrowserRequest[],
  vercel: VercelRequest[],
  toleranceMs = 500
): Array<{ browser: BrowserRequest; vercel: VercelRequest }> {
  const correlated = browser.map((request) => {
    if (!request.requestId) throw new Error("Browser request is missing a requestId");
    const started = Date.parse(request.startedAt);
    let browserPathname: string;
    try {
      browserPathname = new URL(request.path, "https://performance.invalid").pathname;
    } catch {
      throw new Error(`Browser request ${request.requestId} has an invalid path`);
    }
    const candidates = vercel.filter(
      (candidate) =>
        candidate.method === request.method &&
        candidate.path === browserPathname &&
        candidate.statusCode >= 200 &&
        candidate.statusCode < 400 &&
        Math.abs(Date.parse(candidate.timestamp) - started) <= toleranceMs
    );
    if (candidates.length !== 1) {
      throw new Error(
        candidates.length === 0
          ? `No Vercel request matches ${request.requestId}`
          : `Vercel request correlation is ambiguous for ${request.requestId}`
      );
    }
    return { browser: request, vercel: candidates[0] };
  });
  const platformIds = correlated.map(({ vercel: request }) => request.requestId);
  if (new Set(platformIds).size !== platformIds.length) {
    throw new Error("Vercel platform requests must correlate one-to-one with browser requests");
  }
  return correlated;
}
