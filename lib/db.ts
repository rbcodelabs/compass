import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { getActiveSchema } from "./schema";
import { injectUpdatedAtExtension } from "./prisma-updated-at";
import { getManagedPilotContext } from "./preview-automation/managed-context";

declare global {
  var __prisma: AppPrismaClient | undefined;
}

export function getDatabaseUser(): string {
  if (getManagedPilotContext()) return process.env.PGUSER ?? "admin";
  return process.env.PREVIEW_AUTOMATION_ENABLED === "1" ? `${getActiveSchema()}_runtime` : process.env.PGUSER ?? "admin";
}

/**
 * Pool options for the plain-Postgres (`DATABASE_URL`) path.
 *
 * `pg` defaults to 10 connections per Pool, and every serverless instance owns
 * its own Pool. Against a small pooler (e.g. Supabase Free, session mode:
 * pool_size 15) a handful of instances exhausts it and requests fail with
 * EMAXCONNSESSION. Keep the per-instance cap low and recycle idle connections
 * quickly; `DATABASE_POOL_MAX` overrides the cap (e.g. after a plan upgrade).
 */
export function getPlainPoolOptions(
  connectionString: string,
  env: Record<string, string | undefined>,
): { connectionString: string; max: number; idleTimeoutMillis: number } {
  const requested = Number(env.DATABASE_POOL_MAX?.trim() || Number.NaN);
  const max = Number.isInteger(requested) && requested > 0 ? requested : 3;
  return { connectionString, max, idleTimeoutMillis: 10_000 };
}

/**
 * Creates the underlying, unextended PrismaClient.
 *
 * Local dev: if DATABASE_URL is set, connects via plain pg (no DSQL/OIDC).
 * Vercel (preview/prod): uses Aurora DSQL with OIDC token exchange.
 *
 * Prefer `createPrismaClient()` — this returns a client WITHOUT the
 * `updatedAt` injection extension and should only be used where that is
 * explicitly desired (e.g. testing the extension itself).
 */
export function createBasePrismaClient(): PrismaClient {
  const schema = getActiveSchema();
  const automationPreview = process.env.PREVIEW_AUTOMATION_ENABLED === "1";
  if (automationPreview && process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is forbidden in automation previews");
  }

  // ── Plain Postgres path (local dev, Supabase, any DATABASE_URL) ──────────
  if (process.env.DATABASE_URL) {
    const pool = new Pool(getPlainPoolOptions(process.env.DATABASE_URL, process.env));
    // On Vercel, let the platform close idle connections before an instance
    // is suspended so they don't linger against a small pooler limit.
    if (process.env.VERCEL) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("@vercel/functions").attachDatabasePool(pool);
    }
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
    user: getDatabaseUser(),
    database: process.env.PGDATABASE ?? "postgres",
    password: () => automationPreview && !getManagedPilotContext() ? signer.getDbConnectAuthToken() : signer.getDbConnectAdminAuthToken(),
    port: 5432,
    ssl: true,
    max: 20,
  });

  attachDatabasePool(pool);

  const adapter = new PrismaPg(pool, { schema });
  return new PrismaClient({ adapter });
}

/**
 * Creates a PrismaClient with the `updatedAt` injection extension applied.
 * This is what the application should use everywhere.
 */
export function createPrismaClient() {
  return createBasePrismaClient().$extends(injectUpdatedAtExtension);
}

/** The application's PrismaClient type, including client extensions. */
export type AppPrismaClient = ReturnType<typeof createPrismaClient>;

/**
 * The client handed to an interactive `$transaction(async (tx) => ...)`
 * callback on an {@link AppPrismaClient} — the extended equivalent of
 * `Prisma.TransactionClient`.
 *
 * Derived from the client's own `$transaction` signature rather than by
 * re-listing Prisma's internal deny list (`$on`/`$use`/`$extends`/...) by hand,
 * so it cannot drift as the extension set changes.
 */
type InteractiveTransaction = Extract<
  Parameters<AppPrismaClient["$transaction"]>[0],
  (...args: never[]) => unknown
>;
export type AppTransactionClient = Parameters<InteractiveTransaction>[0];

let _prisma: AppPrismaClient | undefined;

/** Returns the singleton PrismaClient, creating it on first call. */
export default function getPrisma(): AppPrismaClient {
  if (global.__prisma) return global.__prisma;
  if (!_prisma) {
    _prisma = createPrismaClient();
    if (process.env.NODE_ENV !== "production") global.__prisma = _prisma;
  }
  return _prisma;
}
