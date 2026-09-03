import { randomUUID } from "node:crypto";

export const PERFORMANCE_SAMPLE_HEADER = "x-compass-perf-request-id";
export const PERFORMANCE_INVOCATION_HEADER = "x-compass-perf-invocation-id";

const SAMPLE_ID = /^perf_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DSQL_HOST = /^[a-z0-9-]+\.dsql\.[a-z0-9-]+\.on\.aws$/;

export function createPreviewPerformanceCorrelation(
  env: NodeJS.ProcessEnv,
  sampleId: string | null,
  createId: () => string = randomUUID,
): { header: typeof PERFORMANCE_INVOCATION_HEADER; invocationId: string } | null {
  if (
    env.VERCEL_ENV !== "preview" ||
    env.COMPASS_PERF_BASELINE !== "1" ||
    env.PERF_SERVER_KIND !== "vercel-preview" ||
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
