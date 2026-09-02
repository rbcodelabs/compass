#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { DsqlSigner } from "@aws-sdk/dsql-signer";
import { awsCredentialsProvider } from "@vercel/functions/oidc";
import { Pool } from "pg";
import { getActiveSchema } from "../lib/schema.ts";
import {
  assertManifestMatchesGuard,
  assertPreviewFixtureGuards,
  buildPreviewFixturePlan,
  cleanupPreviewFixture,
  createConnectorAfterPreviewFixtureGuards,
  parsePreviewFixtureManifest,
  readPrivateManifest,
  redactSensitiveText,
  seedPreviewFixture,
  type PreviewFixtureGuardInput,
} from "../lib/preview-performance-fixture.ts";
import { PrismaPreviewFixtureStore } from "../lib/preview-performance-fixture-prisma.ts";

type Command = "seed" | "cleanup";

interface CliArgs {
  command: Command;
  runId: string;
  deploymentSha: string;
  verifiedDeploymentSha: string;
  deploymentUrl: string;
  deploymentId: string;
  expiresMinutes?: number;
}

function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

export function parsePreviewFixtureArgs(argv: readonly string[]): CliArgs {
  const command = argv[0];
  if (command !== "seed" && command !== "cleanup") throw new Error("Usage: preview-performance-fixture.ts <seed|cleanup> [required flags]");
  const flags = new Map<string, string>();
  const firstFlagIndex = argv[1] === "--" ? 2 : 1;
  for (let index = firstFlagIndex; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`Invalid CLI argument near ${name ?? "end"}`);
    flags.set(name.slice(2), value);
  }
  const allowed = new Set(["run-id", "deployment-sha", "verified-deployment-sha", "deployment-url", "deployment-id", "expires-minutes"]);
  for (const name of flags.keys()) if (!allowed.has(name)) throw new Error(`Unknown CLI flag --${name}`);
  const expiresRaw = flags.get("expires-minutes");
  if (command === "seed" && !expiresRaw) throw new Error("Seed requires explicit --expires-minutes");
  if (command === "cleanup" && expiresRaw) throw new Error("Cleanup does not accept --expires-minutes");
  const expiresMinutes = expiresRaw === undefined ? undefined : Number(expiresRaw);
  if (expiresMinutes !== undefined && (!Number.isInteger(expiresMinutes) || expiresMinutes < 15 || expiresMinutes > 240)) {
    throw new Error("--expires-minutes must be an integer from 15 through 240");
  }
  return {
    command,
    runId: requiredFlag(flags, "run-id"),
    deploymentSha: requiredFlag(flags, "deployment-sha"),
    verifiedDeploymentSha: requiredFlag(flags, "verified-deployment-sha"),
    deploymentUrl: requiredFlag(flags, "deployment-url"),
    deploymentId: requiredFlag(flags, "deployment-id"),
    expiresMinutes,
  };
}

function isIgnored(repoRoot: string, filePath: string): boolean {
  const relativePath = path.relative(repoRoot, filePath);
  const result = spawnSync("git", ["check-ignore", "-q", "--", relativePath], { cwd: repoRoot, stdio: "ignore" });
  return result.status === 0;
}

function assertSafeRepositoryPath(repoRoot: string, filePath: string): void {
  const relativePath = path.relative(repoRoot, filePath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("Fixture state path escaped the repository");
  let current = repoRoot;
  for (const segment of path.dirname(relativePath).split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`Fixture state directory may not be a symlink: ${current}`);
  }
}

function guardInput(args: CliArgs, repoRoot: string, manifestPath: string, authStatePath: string): PreviewFixtureGuardInput {
  const committedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const cleanWorktree = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }).trim() === "";
  return {
    operation: args.command,
    env: process.env,
    runId: args.runId,
    requestedDeploymentSha: args.deploymentSha,
    verifiedDeploymentSha: args.verifiedDeploymentSha,
    committedSha,
    cleanWorktree,
    deploymentUrl: args.deploymentUrl,
    deploymentId: args.deploymentId,
    activeSchema: getActiveSchema(),
    manifestExists: fs.existsSync(manifestPath),
    authStateExists: fs.existsSync(authStatePath),
    manifestPathIgnored: isIgnored(repoRoot, manifestPath),
    authStatePathIgnored: isIgnored(repoRoot, authStatePath),
  };
}

function createDsqlClient(): { prisma: PrismaClient; pool: Pool } {
  const host = process.env.PGHOST!;
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
    max: 4,
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: "compass_preview" }) });
  return { prisma, pool };
}

export async function runPreviewFixtureCli(argv: readonly string[]): Promise<void> {
  const args = parsePreviewFixtureArgs(argv);
  const repoRoot = process.cwd();
  if (!fs.existsSync(path.join(repoRoot, "package.json")) || !fs.existsSync(path.join(repoRoot, "prisma", "schema.prisma"))) {
    throw new Error("Run the preview fixture utility from the Compass repository root");
  }
  const manifestPath = path.join(repoRoot, ".performance-baseline", "preview-fixtures", `${args.runId}.json`);
  const authStatePath = path.join(repoRoot, "e2e", "performance", ".auth", "preview-user.json");
  assertSafeRepositoryPath(repoRoot, manifestPath);
  assertSafeRepositoryPath(repoRoot, authStatePath);
  const guard = guardInput(args, repoRoot, manifestPath, authStatePath);
  assertPreviewFixtureGuards(guard);

  if (args.command === "cleanup") {
    const manifest = parsePreviewFixtureManifest(readPrivateManifest(manifestPath));
    assertManifestMatchesGuard(manifest, guard);
  }

  const { prisma, pool } = createConnectorAfterPreviewFixtureGuards(guard, createDsqlClient);
  const store = new PrismaPreviewFixtureStore(prisma);
  try {
    if (args.command === "seed") {
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + args.expiresMinutes! * 60_000);
      const plan = buildPreviewFixturePlan({
        runId: args.runId,
        deploymentSha: args.deploymentSha,
        deploymentUrl: args.deploymentUrl,
        deploymentId: args.deploymentId,
        schema: "compass_preview",
        createdAt,
        expiresAt,
        sessionToken: crypto.randomBytes(32).toString("base64url"),
        idFactory: () => crypto.randomUUID(),
      });
      await seedPreviewFixture({ plan, store, manifestPath, authStatePath });
      process.stdout.write(`Seeded preview performance fixture ${args.runId}\n`);
    } else {
      await cleanupPreviewFixture({ store, manifestPath, authStatePath });
      process.stdout.write(`Cleaned preview performance fixture ${args.runId}; verified zero residue\n`);
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runPreviewFixtureCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Preview fixture failed: ${redactSensitiveText(message, [
      process.env.VERCEL_OIDC_TOKEN,
      process.env.AWS_ACCESS_KEY_ID,
      process.env.AWS_SECRET_ACCESS_KEY,
      process.env.AWS_SESSION_TOKEN,
    ])}\n`);
    process.exitCode = 1;
  });
}
