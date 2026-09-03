import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

export const PERFORMANCE_SAMPLE_HEADER = "x-compass-perf-request-id";
export const PERFORMANCE_BUILD_SHA_HEADER = "x-compass-perf-build-sha";
export const PERFORMANCE_INVOCATION_HEADER = "x-compass-perf-invocation-id";
export const PERFORMANCE_ISSUED_AT_HEADER = "x-compass-perf-issued-at";
export const PERFORMANCE_TAG_HEADER = "x-compass-perf-tag";
export const PERFORMANCE_METHOD_HEADER = "x-compass-perf-method";
export const PERFORMANCE_PATH_HEADER = "x-compass-perf-path";

const RESERVED = [PERFORMANCE_INVOCATION_HEADER, PERFORMANCE_ISSUED_AT_HEADER, PERFORMANCE_TAG_HEADER,
  PERFORMANCE_METHOD_HEADER, PERFORMANCE_PATH_HEADER] as const;
const SAMPLE_ID = /^perf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVOCATION_ID = /^perf_inv_[0-9a-f]{32}$/;
const DSQL_HOST = /^[a-z0-9-]+\.dsql\.[a-z0-9-]+\.on\.aws$/;
const MAX_AGE_MS = 30_000;
const STORE = new AsyncLocalStorage<string>();
type UnsignedCorrelation = { invocationId: string; issuedAt: string; method: string; pathname: string };
type Correlation = UnsignedCorrelation & { header: typeof PERFORMANCE_INVOCATION_HEADER; tag: string };

function exactRuntime(env: NodeJS.ProcessEnv, expectedSha: string | null): boolean {
  return env.VERCEL_ENV === "preview" && env.COMPASS_PERF_BASELINE === "1" &&
    env.PERF_SERVER_KIND === "vercel-preview" && !!expectedSha && /^[a-f0-9]{40}$/.test(expectedSha) &&
    env.VERCEL_GIT_COMMIT_SHA === expectedSha && !!env.VERCEL_DEPLOYMENT_ID &&
    /^dpl_[A-Za-z0-9]{20,64}$/.test(env.VERCEL_DEPLOYMENT_ID) && !!env.VERCEL_OIDC_TOKEN &&
    (env.PGSCHEMA ?? "compass") === "compass" && !!env.PGHOST && DSQL_HOST.test(env.PGHOST) &&
    !env.DATABASE_URL && !env.AWS_PROFILE && !env.AWS_ACCESS_KEY_ID &&
    !env.AWS_SECRET_ACCESS_KEY && !env.AWS_SESSION_TOKEN &&
    !!env.MIGRATION_SECRET && env.MIGRATION_SECRET.length >= 24;
}

function canonical(value: UnsignedCorrelation, sha: string, deployment: string): string {
  return ["v1", value.invocationId, sha, deployment, value.method, value.pathname, value.issuedAt].join("|");
}

export function createPreviewPerformanceCorrelation(
  env: NodeJS.ProcessEnv, sampleId: string | null, expectedSha: string | null,
  method = "GET", pathname = "/", now = Date.now(), createId = () => randomBytes(16).toString("hex"),
): Correlation | null {
  if (!exactRuntime(env, expectedSha) || !sampleId || !SAMPLE_ID.test(sampleId) ||
      !/^[A-Z]+$/.test(method) || !pathname.startsWith("/") || pathname.includes("?")) return null;
  const unsigned = { invocationId: `perf_inv_${createId()}`, issuedAt: String(now), method, pathname };
  if (!INVOCATION_ID.test(unsigned.invocationId)) return null;
  const tag = createHmac("sha256", env.MIGRATION_SECRET!).update(canonical(
    unsigned, env.VERCEL_GIT_COMMIT_SHA!, env.VERCEL_DEPLOYMENT_ID!,
  )).digest("hex");
  return { ...unsigned, header: PERFORMANCE_INVOCATION_HEADER, tag };
}

export function createServerOwnedPerformanceHeaders(incoming: Headers, correlation: Correlation | null): Headers {
  const headers = new Headers(incoming);
  for (const name of RESERVED) headers.delete(name);
  if (correlation) {
    headers.set(PERFORMANCE_INVOCATION_HEADER, correlation.invocationId);
    headers.set(PERFORMANCE_ISSUED_AT_HEADER, correlation.issuedAt);
    headers.set(PERFORMANCE_TAG_HEADER, correlation.tag);
    headers.set(PERFORMANCE_METHOD_HEADER, correlation.method);
    headers.set(PERFORMANCE_PATH_HEADER, correlation.pathname);
  }
  return headers;
}

export function verifyDownstreamPerformanceCorrelation(
  env: NodeJS.ProcessEnv, headers: Headers, now: number, method: string | null,
  pathname: string | null,
): string | null {
  const sha = env.VERCEL_GIT_COMMIT_SHA ?? null;
  if (!exactRuntime(env, sha) || !method || !pathname) return null;
  const invocationId = headers.get(PERFORMANCE_INVOCATION_HEADER);
  const issuedAt = headers.get(PERFORMANCE_ISSUED_AT_HEADER);
  const tag = headers.get(PERFORMANCE_TAG_HEADER);
  if (!invocationId || !INVOCATION_ID.test(invocationId) || !issuedAt || !/^\d{13}$/.test(issuedAt) ||
      !tag || !/^[a-f0-9]{64}$/.test(tag) || headers.get(PERFORMANCE_METHOD_HEADER) !== method ||
      headers.get(PERFORMANCE_PATH_HEADER) !== pathname) return null;
  const age = now - Number(issuedAt);
  if (age < 0 || age > MAX_AGE_MS) return null;
  const expected = createHmac("sha256", env.MIGRATION_SECRET!).update(canonical(
    { invocationId, issuedAt, method, pathname }, sha!, env.VERCEL_DEPLOYMENT_ID!,
  )).digest();
  const supplied = Buffer.from(tag, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? invocationId : null;
}

export function runWithPerformanceInvocation<T>(id: string | null, callback: () => T): T {
  return id ? STORE.run(id, callback) : callback();
}
export function currentPerformanceInvocation(): string | null { return STORE.getStore() ?? null; }
