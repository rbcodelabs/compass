/**
 * Returns the active PostgreSQL schema name for the current environment.
 *
 * The schema name is always "{prefix}_{suffix}" where:
 *   - prefix: PGSCHEMA env var if set, otherwise "compass"
 *   - suffix: derived from the current environment
 *       NODE_ENV=development  → "dev"
 *       VERCEL_ENV=preview    → "preview"
 *       VERCEL_ENV=production → "prod"
 *
 * Examples with PGSCHEMA=compass: compass_dev, compass_preview, compass_prod
 */
export function getActiveSchema(): string {
  const exactPerformanceSchema = process.env.COMPASS_PERF_SCHEMA;
  if (exactPerformanceSchema) {
    if (process.env.COMPASS_PERF_BASELINE !== "1") {
      throw new Error("COMPASS_PERF_SCHEMA requires COMPASS_PERF_BASELINE=1");
    }
    if (!/^compass_perf_[a-f0-9]{16}$/.test(exactPerformanceSchema)) {
      throw new Error("Invalid exact performance schema");
    }
    return exactPerformanceSchema;
  }
  const prefix = process.env.PGSCHEMA ?? "compass";

  if (process.env.NODE_ENV === "development") return `${prefix}_dev`;

  const vercelEnv = process.env.VERCEL_ENV;
  if (vercelEnv === "preview") return `${prefix}_preview`;
  if (vercelEnv === "production") return `${prefix}_prod`;

  return `${prefix}_dev`;
}
