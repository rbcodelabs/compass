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

async function createPrismaClient(): Promise<PrismaClient> {
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
    password: () => signer.getDbConnectAdminAuthToken(),
    port: 5432,
    ssl: true,
    max: 20,
  });

  attachDatabasePool(pool);

  // Pass schema as second arg — PrismaPg surfaces it via getConnectionInfo().schemaName,
  // which Prisma uses to issue SET search_path before each query.
  // Note: options: --search_path does NOT work on Aurora DSQL.
  const adapter = new PrismaPg(pool, { schema });
  return new PrismaClient({ adapter });
}

let prismaPromise: Promise<PrismaClient>;

export default function getPrisma(): Promise<PrismaClient> {
  if (global.__prisma) return Promise.resolve(global.__prisma);
  if (!prismaPromise) {
    prismaPromise = createPrismaClient().then((client) => {
      if (process.env.NODE_ENV !== "production") global.__prisma = client;
      return client;
    });
  }
  return prismaPromise;
}
