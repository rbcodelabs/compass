import { DsqlSigner } from "@aws-sdk/dsql-signer"
import { awsCredentialsProvider } from "@vercel/functions/oidc"
import { Pool, type PoolClient } from "pg"
import { getActiveSchema } from "@/lib/schema"

async function createAdminPool() {
  if (process.env.DATABASE_URL) return new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  const host = process.env.PGHOST
  if (!host) throw new Error("Neither DATABASE_URL nor PGHOST is configured.")
  const signer = new DsqlSigner({
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN!,
      clientConfig: { region: process.env.AWS_REGION },
    }),
    hostname: host,
    region: process.env.AWS_REGION ?? "us-east-1",
    expiresIn: 900,
  })
  return new Pool({
    host,
    user: process.env.PGUSER ?? "admin",
    database: process.env.PGDATABASE ?? "postgres",
    password: () => signer.getDbConnectAdminAuthToken(),
    port: 5432,
    ssl: true,
    max: 3,
  })
}

export async function withAdminDsqlClient<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await createAdminPool()
  const client = await pool.connect()
  try {
    await client.query(`SET search_path TO "${getActiveSchema()}"`)
    return await operation(client)
  } finally {
    client.release()
    await pool.end()
  }
}
