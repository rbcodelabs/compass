#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createPreviewFixtureAuthState,
  createPreviewFixtureManifest,
  buildDeterministicPreviewFixturePlan,
  parsePreviewFixtureManifest,
  readPrivateManifest,
  redactSensitiveText,
  writePrivateJson,
} from "../lib/preview-performance-fixture.ts";

type Command = "seed" | "cleanup" | "verify";

function fail(message: string): never { throw new Error(message); }

export function parsePreviewFixtureOrchestrationArgs(argv: readonly string[]) {
  const command = argv[0] as Command;
  if (!(["seed", "cleanup", "verify"] as const).includes(command)) fail("Usage: run-preview-performance-fixture.ts <seed|cleanup|verify> [flags]");
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) fail("Invalid fixture orchestration argument");
    flags.set(flag.slice(2), value);
  }
  const allowed = new Set(["run-id", "deployment-sha", "deployment-id", "deployment-url", "expires-minutes"]);
  if ([...flags.keys()].some((key) => !allowed.has(key))) fail("Unknown fixture orchestration argument");
  const required = (key: string) => flags.get(key) ?? fail(`Missing --${key}`);
  const expiresMinutes = Number(flags.get("expires-minutes") ?? "20");
  if (!Number.isInteger(expiresMinutes) || expiresMinutes < 15 || expiresMinutes > 30) fail("--expires-minutes must be 15 through 30");
  return {
    command,
    runId: required("run-id"),
    expectedSha: required("deployment-sha"),
    expectedDeploymentId: required("deployment-id"),
    deploymentUrl: required("deployment-url"),
    expiresMinutes,
  };
}

function assertLocalGuards(args: ReturnType<typeof parsePreviewFixtureOrchestrationArgs>, repoRoot: string): URL {
  if (process.env.COMPASS_PERF_BASELINE !== "1" || process.env.PERF_SERVER_KIND !== "vercel-preview") fail("Preview performance flags are required");
  if (!process.env.MIGRATION_SECRET || process.env.MIGRATION_SECRET.length < 24) fail("A protected migration secret is required");
  if (!process.env.VERCEL_AUTOMATION_BYPASS_SECRET) fail("Deployment Protection credentials are required");
  const committedSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }).trim();
  if (dirty || committedSha !== args.expectedSha) fail("Fixture orchestration requires the exact clean committed SHA");
  if (!/^perf_preview_[a-f0-9]{32}$/.test(args.runId)) fail("Invalid randomized run ID");
  if (!/^dpl_[A-Za-z0-9]{20,64}$/.test(args.expectedDeploymentId)) fail("Invalid immutable deployment ID");
  const url = new URL(args.deploymentUrl);
  if (url.protocol !== "https:" || !/^compass-[a-z0-9]+-rbcodelabs-team\.vercel\.app$/.test(url.hostname) || url.pathname !== "/") {
    fail("An exact unaliased Compass deployment URL is required");
  }
  return url;
}

function paths(repoRoot: string, runId: string) {
  return {
    manifestPath: path.join(repoRoot, ".performance-baseline", "preview-fixtures", `${runId}.json`),
    authStatePath: path.join(repoRoot, "e2e", "performance", ".auth", "preview-user.json"),
  };
}

function assertIgnored(repoRoot: string, filePath: string): void {
  const relative = path.relative(repoRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Fixture state path escaped the repository");
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relative], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    fail("Fixture recovery and auth paths must remain ignored by git");
  }
}

async function invoke(url: URL, body: object): Promise<Record<string, unknown>> {
  const response = await fetch(new URL("/api/admin/performance-fixture", url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-migration-secret": process.env.MIGRATION_SECRET!,
      "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET!,
    },
    body: JSON.stringify(body),
    cache: "no-store",
    redirect: "error",
  });
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !result) fail(`Fixture action refused with HTTP ${response.status}`);
  return result;
}

export function validatePreviewFixtureResponse(command: Command, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid fixture response");
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result);
  if (keys.some((key) => !["state", "residue", "replayed"].includes(key))) fail("Invalid fixture response");
  if (typeof result.state !== "string" || typeof result.residue !== "number" || !Number.isInteger(result.residue)) fail("Invalid fixture response");
  if ("replayed" in result && typeof result.replayed !== "boolean") fail("Invalid fixture response");
  if (command === "seed" && (result.state !== "seeded" || result.residue !== 1231)) fail("Invalid seed fixture response");
  if (command !== "seed" && (result.state !== "absent" || result.residue !== 0)) fail(`Invalid ${command} fixture response`);
  return result;
}

export async function runPreviewFixtureOrchestration(argv: readonly string[]): Promise<void> {
  const args = parsePreviewFixtureOrchestrationArgs(argv);
  const repoRoot = process.cwd();
  const url = assertLocalGuards(args, repoRoot);
  const statePaths = paths(repoRoot, args.runId);
  assertIgnored(repoRoot, statePaths.manifestPath);
  assertIgnored(repoRoot, statePaths.authStatePath);
  const expiresAt = new Date(Date.now() + args.expiresMinutes * 60_000).toISOString();
  let sessionToken: string | undefined;

  if (args.command === "seed") {
    if (fs.existsSync(statePaths.manifestPath) || fs.existsSync(statePaths.authStatePath)) fail("Recovery state already exists; seed refused");
    sessionToken = crypto.randomBytes(32).toString("base64url");
    const plan = buildDeterministicPreviewFixturePlan({
      runId: args.runId,
      deploymentSha: args.expectedSha,
      deploymentId: args.expectedDeploymentId,
      deploymentUrl: url.href,
      expiresAt: new Date(expiresAt),
      sessionToken,
    });
    writePrivateJson(statePaths.manifestPath, createPreviewFixtureManifest(plan));
    writePrivateJson(statePaths.authStatePath, createPreviewFixtureAuthState(plan));
  } else {
    const manifest = parsePreviewFixtureManifest(readPrivateManifest(statePaths.manifestPath));
    if (manifest.identity.runId !== args.runId || manifest.identity.deploymentSha !== args.expectedSha || manifest.identity.deploymentId !== args.expectedDeploymentId) {
      fail("Recovery manifest does not match the exact deployment identity");
    }
  }

  const result = validatePreviewFixtureResponse(args.command, await invoke(url, {
    action: args.command,
    runId: args.runId,
    expectedSha: args.expectedSha,
    expectedDeploymentId: args.expectedDeploymentId,
    expiresAt,
    ...(sessionToken ? { sessionToken } : {}),
  }));
  process.stdout.write(`${args.command} accepted: state=${String(result.state)} residue=${String(result.residue)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  runPreviewFixtureOrchestration(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactSensitiveText(message, [process.env.MIGRATION_SECRET, process.env.VERCEL_AUTOMATION_BYPASS_SECRET])}\n`);
    process.exitCode = 1;
  });
}
