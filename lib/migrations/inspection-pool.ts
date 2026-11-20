import { Pool, type PoolConfig } from "pg"
import { usesPlainPostgres } from "@/lib/db-url"

export type InspectionPoolFactory = () => Pool | Promise<Pool>

/** Build from the original config, preserving IAM callbacks and excluding unsupported DSQL startup parameters. */
export function createInspectionPool(config: PoolConfig, plainPostgres = usesPlainPostgres(process.env)): Pool {
  const options = { ...config, password: config.password }
  delete options.statement_timeout
  return new Pool({
    ...options,
    // pg-pool makes this property non-enumerable; preserve it even for callers passing existing pool options.
    max: 1,
    connectionTimeoutMillis: 1000,
    query_timeout: 2000,
    ...(plainPostgres ? { statement_timeout: 2000 } : {}),
  })
}
