#!/usr/bin/env node
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redactSensitiveText } from "../lib/preview-performance-fixture.ts";

export function parseRecoveryArgs(argv: readonly string[]) {
  const action = argv[0];
  if (action !== "cleanup" && action !== "verify") throw new Error("Usage: run-preview-performance-recovery.ts <cleanup|verify> [flags]");
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) throw new Error("Invalid recovery argument");
    flags.set(flag.slice(2), value);
  }
  if ([...flags.keys()].some((key) => !["deployment-sha", "deployment-id", "deployment-url"].includes(key))) throw new Error("Unknown recovery argument");
  const required = (key: string) => flags.get(key) ?? (() => { throw new Error(`Missing --${key}`); })();
  return { action, expectedSha: required("deployment-sha"), expectedDeploymentId: required("deployment-id"), deploymentUrl: required("deployment-url") };
}

export async function runRecovery(argv: readonly string[]): Promise<void> {
  const args = parseRecoveryArgs(argv);
  if (process.env.COMPASS_PERF_BASELINE !== "1" || process.env.PERF_SERVER_KIND !== "vercel-preview") throw new Error("Preview recovery flags are required");
  if (!process.env.MIGRATION_SECRET || process.env.MIGRATION_SECRET.length < 24 || !process.env.VERCEL_AUTOMATION_BYPASS_SECRET) throw new Error("Protected preview credentials are required");
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).trim();
  if (dirty || sha !== args.expectedSha) throw new Error("Recovery requires the exact clean committed executor SHA");
  if (!/^dpl_[A-Za-z0-9]{20,64}$/.test(args.expectedDeploymentId)) throw new Error("Invalid executor deployment ID");
  const url = new URL(args.deploymentUrl);
  if (url.protocol !== "https:" || !/^compass-[a-z0-9]+-rbcodelabs-team\.vercel\.app$/.test(url.hostname) || url.pathname !== "/") throw new Error("Exact unaliased Compass executor URL required");
  const body = JSON.stringify({ action: args.action, expectedSha: args.expectedSha, expectedDeploymentId: args.expectedDeploymentId, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString() });
  const response = await fetch(new URL("/api/admin/performance-fixture-recovery", url), {
    method: "POST",
    headers: { "content-type": "application/json", "x-migration-secret": process.env.MIGRATION_SECRET, "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET },
    body,
    cache: "no-store",
    redirect: "error",
  });
  const result = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !result || result.state !== "absent" || result.residue !== 0 || Object.keys(result).length !== 2) throw new Error(`Recovery action refused with HTTP ${response.status}`);
  process.stdout.write(`${args.action} accepted: state=absent residue=0\n`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) {
  runRecovery(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redactSensitiveText(message, [process.env.MIGRATION_SECRET, process.env.VERCEL_AUTOMATION_BYPASS_SECRET])}\n`);
    process.exitCode = 1;
  });
}
