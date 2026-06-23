import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { attachDatabasePool } from "@vercel/functions";
import { getActiveSchema } from "./schema";

declare global {
  var __prisma: PrismaClient | undefined;
}

/**
 * Creates a PrismaClient synchronously.
 *
 * All async work (OIDC token exchange, actual DB connection) happens lazily
 * when the first query runs — the Pool's `password` callback is invoked only
 * at connection time, not at construction time. So this function is safe to
 * call at module-load time (e.g. when wiring up the Auth.js adapter).
 */
export function createPrismaClient(): PrismaClient {
  const host = process.env.PGHOST;

  if (!host) {
    throw new Error(
      "PGHOST is not set. The Aurora DSQL integration must be configured in your Vercel project."
    );
  }

  const schema = getActiveSchema();

  const signer = new DsqlSigner({
    credentials: awsCredentialsProvider({
      roleArn: process.env.AWS_ROLE_ARN!,
      clientConfig: { region: process.env.AWS_REGION },
    }),
    region: process.env.AWS_REGION!,
    hostname: host,
    expiresIn: 900,
  });

  const pool = new Pool({
    host,
    user: process.env.PGUSER ?? "admin",
    database: process.env.PGDATABASE ?? "postgres",
    // password is a callback — invoked lazily at connection time, not now
    password: () => signer.getDbConnectAdminAuthToken(),
    port: 5432,
    ssl: true,
    max: 20,
  });

  attachDatabasePool(pool);

  const adapter = new PrismaPg(pool, { schema });
  return new PrismaClient({ adapter });
}

let _prisma: PrismaClient | undefined;

/** Returns the singleton PrismaClient, creating it on first call. */
export default function getPrisma(): PrismaClient {
  if (global.__prisma) return global.__prisma;
  if (!_prisma) {
    _prisma = createPrismaClient();
    if (process.env.NODE_ENV !== "production") global.__prisma = _prisma;
  }
  return _prisma;
}
