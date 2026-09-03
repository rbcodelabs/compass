import { randomUUID } from "node:crypto";

export const PERFORMANCE_SAMPLE_HEADER = "x-compass-perf-request-id";
export const PERFORMANCE_INVOCATION_HEADER = "x-compass-perf-invocation-id";
export const PERFORMANCE_BUILD_SHA_HEADER = "x-compass-perf-build-sha";

const SAMPLE_ID = /^perf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DSQL_HOST = /^[a-z0-9-]+\.dsql\.[a-z0-9-]+\.on\.aws$/;

export function createPreviewPerformanceCorrelation(
  env: NodeJS.ProcessEnv,
  sampleId: string | null,
  expectedSha: string | null,
  createId: () => string = randomUUID,
): { header: typeof PERFORMANCE_INVOCATION_HEADER; invocationId: string } | null {
  if (
    env.VERCEL_ENV !== "preview" ||
    env.COMPASS_PERF_BASELINE !== "1" ||
    env.PERF_SERVER_KIND !== "vercel-preview" ||
    !expectedSha || !/^[a-f0-9]{40}$/.test(expectedSha) ||
    env.VERCEL_GIT_COMMIT_SHA !== expectedSha ||
    !env.VERCEL_OIDC_TOKEN ||
    (env.PGSCHEMA ?? "compass") !== "compass" ||
    !env.PGHOST || !DSQL_HOST.test(env.PGHOST) ||
    env.DATABASE_URL || env.AWS_PROFILE || env.AWS_ACCESS_KEY_ID ||
    env.AWS_SECRET_ACCESS_KEY || env.AWS_SESSION_TOKEN ||
    !sampleId || !SAMPLE_ID.test(sampleId)
  ) return null;

  return {
    header: PERFORMANCE_INVOCATION_HEADER,
    invocationId: `perf_inv_${createId().replaceAll("-", "")}`,
  };
}

export function createServerOwnedPerformanceHeaders(
  incoming: Headers,
  correlation: { invocationId: string } | null,
): Headers {
  const headers = new Headers(incoming);
  headers.delete(PERFORMANCE_INVOCATION_HEADER);
  if (correlation) headers.set(PERFORMANCE_INVOCATION_HEADER, correlation.invocationId);
  return headers;
}
