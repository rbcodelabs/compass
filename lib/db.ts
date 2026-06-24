import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { getActiveSchema } from "./schema";

declare global {
  var __prisma: PrismaClient | undefined;
}

/**
 * Creates a PrismaClient.
 *
 * Local dev: if DATABASE_URL is set, connects via plain pg (no DSQL/OIDC).
 * Vercel (preview/prod): uses Aurora DSQL with OIDC token exchange.
 */
export function createPrismaClient(): PrismaClient {
  const schema = getActiveSchema();

  // ── Local dev path ────────────────────────────────────────────────────────
  if (process.env.DATABASE_URL) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const adapter = new PrismaPg(pool, { schema });
    return new PrismaClient({ adapter });
  }

  // ── Vercel / Aurora DSQL path ─────────────────────────────────────────────
  const host = process.env.PGHOST;
  if (!host) {
    throw new Error(
      "Neither DATABASE_URL nor PGHOST is set. " +
        "For local dev set DATABASE_URL; for Vercel set PGHOST + AWS credentials."
    );
  }

  // Lazy-import Vercel/AWS deps so they never break local builds
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DsqlSigner } = require("@aws-sdk/dsql-signer");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { awsCredentialsProvider } = require("@vercel/functions/oidc");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { attachDatabasePool } = require("@vercel/functions");

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
