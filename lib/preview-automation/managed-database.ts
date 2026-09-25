import { Pool } from "pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { getManagedPilotContext, type ManagedPilotContext } from "./managed-context";
import { assertManagedPilotReady } from "./managed-migrations";

// One CALL sys.wait_for_job for a DSQL async index can exceed 40s (it did for
// 047_research_voice_control_plane). Stay inside the migrate route's 300s budget.
export const MANAGED_QUERY_TIMEOUT_MS = 280_000;

export function createManagedMigrationPool(): Pool {
  if (!getManagedPilotContext()) throw new Error("Managed pilot is not enabled");
  const host = process.env.PGHOST;
  const roleArn = process.env.AWS_ROLE_ARN;
  if (!host || !roleArn) throw new Error("Managed database credentials are not configured");
  const signer = new DsqlSigner({ credentials: awsCredentialsProvider({ roleArn, clientConfig: { region: process.env.AWS_REGION } }), hostname: host, region: process.env.AWS_REGION ?? "us-east-1", expiresIn: 900 });
  return new Pool({ host, user: process.env.PGUSER ?? "admin", database: process.env.PGDATABASE ?? "postgres", password: () => signer.getDbConnectAdminAuthToken(), port: 5432, ssl: true, max: 4, query_timeout: MANAGED_QUERY_TIMEOUT_MS });
}

export async function assertManagedPilotDeploymentReady(context: ManagedPilotContext): Promise<void> {
  const configured = getManagedPilotContext();
  if (!configured || JSON.stringify(configured) !== JSON.stringify(context)) throw new Error("Managed context changed");
  const pool = createManagedMigrationPool();
  try { await assertManagedPilotReady(pool, context); } finally { await pool.end(); }
}
