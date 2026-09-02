import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  CLEANUP_ORDER,
  FIXTURE_COUNTS,
  MAX_DSQL_TRANSACTION_ROWS,
  SEED_ORDER,
  assertManifestMatchesGuard,
  assertPreviewFixtureGuards,
  buildPreviewFixturePlan,
  cleanupPreviewFixture,
  createConnectorAfterPreviewFixtureGuards,
  createPreviewFixtureManifest,
  readPrivateManifest,
  seedPreviewFixture,
  writePrivateJson,
  type PreviewFixtureGuardInput,
  type PreviewFixtureStore,
} from "@/lib/preview-performance-fixture";
import { PrismaPreviewFixtureStore } from "@/lib/preview-performance-fixture-prisma";

const RUN_ID = "perf_preview_0123456789abcdef0123456789abcdef";
const SHA = "a".repeat(40);
const DEPLOYMENT_URL = "https://compass-brea5dc7o-rbcodelabs-team.vercel.app";

function validGuards(overrides: Partial<PreviewFixtureGuardInput> = {}): PreviewFixtureGuardInput {
  return {
    operation: "seed",
    env: {
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_SHA: SHA,
      COMPASS_PERF_BASELINE: "1",
      PERF_SERVER_KIND: "vercel-preview",
      PGSCHEMA: "compass",
      PGHOST: "example.dsql.us-east-1.on.aws",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/preview",
      AWS_REGION: "us-east-1",
      VERCEL_OIDC_TOKEN: "unit-test-not-a-secret",
    },
    runId: RUN_ID,
    requestedDeploymentSha: SHA,
    verifiedDeploymentSha: SHA,
    committedSha: SHA,
    cleanWorktree: true,
    deploymentUrl: DEPLOYMENT_URL,
    deploymentId: "dpl_6Kf7JXNTuRu2AaAWoznGoABcW4Bn",
    activeSchema: "compass_preview",
    manifestExists: false,
    authStateExists: false,
    manifestPathIgnored: true,
    authStatePathIgnored: true,
    ...overrides,
  };
}

function createPlan() {
  let id = 0;
  return buildPreviewFixturePlan({
    runId: RUN_ID,
    deploymentSha: SHA,
    deploymentUrl: DEPLOYMENT_URL,
    deploymentId: "dpl_6Kf7JXNTuRu2AaAWoznGoABcW4Bn",
    schema: "compass_preview",
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    expiresAt: new Date("2026-09-01T14:00:00.000Z"),
    sessionToken: "private-session-token",
    idFactory: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
  });
}

class RecordingStore implements PreviewFixtureStore {
  readonly inserts: Array<{ kind: string; count: number }> = [];
  readonly deletes: Array<{ kind: string; count: number }> = [];
  ownershipValid = true;
  residue = 0;
  insertFailureKind: string | null = null;
  insertFailureMessage: string | null = null;
  deleteFailureKind: string | null = null;

  async insert(kind: Parameters<PreviewFixtureStore["insert"]>[0], rows: readonly Record<string, unknown>[]) {
    this.inserts.push({ kind, count: rows.length });
    if (kind === this.insertFailureKind) throw new Error(this.insertFailureMessage ?? `insert failed: ${kind}`);
  }

  async verifyOwnership() {
    if (!this.ownershipValid) throw new Error("fixture ownership mismatch");
  }

  async deleteIds(kind: Parameters<PreviewFixtureStore["deleteIds"]>[0], ids: readonly string[]) {
    this.deletes.push({ kind, count: ids.length });
    if (kind === this.deleteFailureKind) throw new Error(`delete failed: ${kind}`);
  }

  async countResidue() {
    return this.residue;
  }
}

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "compass-preview-fixture-test-"));
  tempRoots.push(root);
  return {
    manifestPath: path.join(root, ".performance-baseline", "preview-fixtures", `${RUN_ID}.json`),
    authStatePath: path.join(root, "e2e", "performance", ".auth", "preview-user.json"),
  };
}

describe("preview fixture hard guards", () => {
  it("accepts only the exact clean preview DSQL deployment identity", () => {
    expect(() => assertPreviewFixtureGuards(validGuards())).not.toThrow();
  });

  const refusals: Array<[string, Partial<PreviewFixtureGuardInput>, RegExp]> = [
    ["production environment", { env: { ...validGuards().env, VERCEL_ENV: "production" } }, /preview/],
    ["missing opt in", { env: { ...validGuards().env, COMPASS_PERF_BASELINE: undefined } }, /COMPASS_PERF_BASELINE/],
    ["wrong server kind", { env: { ...validGuards().env, PERF_SERVER_KIND: "local-production" } }, /PERF_SERVER_KIND/],
    ["production schema", { activeSchema: "compass_prod" }, /compass_preview/],
    ["schema prefix drift", { env: { ...validGuards().env, PGSCHEMA: "tenant" } }, /PGSCHEMA/],
    ["local database URL", { env: { ...validGuards().env, DATABASE_URL: "postgresql://localhost/compass" } }, /DATABASE_URL/],
    ["AWS profile fallback", { env: { ...validGuards().env, AWS_PROFILE: "default" } }, /profiles.*forbidden/],
    ["static AWS keys", { env: { ...validGuards().env, AWS_ACCESS_KEY_ID: "AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" } }, /static AWS credentials/],
    ["non DSQL host", { env: { ...validGuards().env, PGHOST: "db.example.com" } }, /DSQL/],
    ["missing IAM role", { env: { ...validGuards().env, AWS_ROLE_ARN: undefined } }, /AWS_ROLE_ARN/],
    ["missing AWS region", { env: { ...validGuards().env, AWS_REGION: undefined } }, /AWS_REGION/],
    ["missing OIDC token", { env: { ...validGuards().env, VERCEL_OIDC_TOKEN: undefined } }, /VERCEL_OIDC_TOKEN/],
    ["invalid run ID", { runId: "perf_preview_predictable" }, /run ID/],
    ["dirty commit", { cleanWorktree: false }, /clean/],
    ["requested SHA mismatch", { requestedDeploymentSha: "b".repeat(40) }, /SHA/],
    ["verified SHA mismatch", { verifiedDeploymentSha: "b".repeat(40) }, /SHA/],
    ["Vercel SHA mismatch", { env: { ...validGuards().env, VERCEL_GIT_COMMIT_SHA: "b".repeat(40) } }, /SHA/],
    ["production alias", { deploymentUrl: "https://compass.rbcodelabs.com" }, /deployment URL/],
    ["unapproved Vercel team", { deploymentUrl: "https://compass-test-other-team.vercel.app" }, /deployment URL/],
    ["URL with path", { deploymentUrl: `${DEPLOYMENT_URL}/login` }, /deployment URL/],
    ["invalid deployment ID", { deploymentId: "production" }, /deployment ID/],
    ["existing manifest", { manifestExists: true }, /manifest already exists/],
    ["existing auth state", { authStateExists: true }, /auth state already exists/],
    ["tracked manifest path", { manifestPathIgnored: false }, /ignored/],
    ["tracked auth path", { authStatePathIgnored: false }, /ignored/],
  ];

  it.each(refusals)("refuses %s", (_name, override, message) => {
    expect(() => assertPreviewFixtureGuards(validGuards(override))).toThrow(message);
  });

  it("refuses a missing Vercel OIDC token before connector creation", () => {
    const connector = vi.fn(() => ({ connected: true }));
    const missingOidc = validGuards({ env: { ...validGuards().env, VERCEL_OIDC_TOKEN: undefined } });
    expect(() => createConnectorAfterPreviewFixtureGuards(missingOidc, connector)).toThrow(/VERCEL_OIDC_TOKEN/);
    expect(connector).not.toHaveBeenCalled();
  });

  it("requires recovery state for cleanup and accepts the same re-proven identity", () => {
    const cleanup = validGuards({ operation: "cleanup", manifestExists: true, authStateExists: true });
    expect(() => assertPreviewFixtureGuards(cleanup)).not.toThrow();
    expect(() => assertPreviewFixtureGuards({ ...cleanup, manifestExists: false })).toThrow(/existing recovery manifest/);
    expect(() => assertManifestMatchesGuard(createPreviewFixtureManifest(createPlan()), cleanup)).not.toThrow();
    expect(() => assertManifestMatchesGuard(createPreviewFixtureManifest(createPlan()), { ...cleanup, deploymentId: "dpl_AnotherExactDeployment123" })).toThrow(/re-proven/);
  });

});

describe("preview fixture plan and private artifacts", () => {
  it("builds the deterministic local-equivalent graph and target records", () => {
    const plan = createPlan();
    expect(Object.fromEntries(Object.entries(plan.rows).map(([kind, rows]) => [kind, rows.length]))).toEqual(FIXTURE_COUNTS);
    expect(plan.rows.opportunities[0]).toMatchObject({ title: "Performance Opportunity Target", sortOrder: 0 });
    expect(plan.rows.roadmapItems[0]).toMatchObject({ title: "Performance Roadmap Target", sortOrder: 0 });
    expect(plan.rows.users[0]).toMatchObject({ email: `${RUN_ID}@performance.invalid` });
    expect(plan.rows.organizations[0]).toMatchObject({ slug: RUN_ID.replaceAll("_", "-") });
    expect(plan.rows.sessions[0]).toMatchObject({ sessionToken: "private-session-token" });
    expect(new Set(Object.values(plan.rows).flatMap((rows) => rows.map((row) => row.id))).size).toBe(1231);
  });

  it("excludes the session token and connection secrets from the recovery manifest", () => {
    const manifest = createPreviewFixtureManifest(createPlan());
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("private-session-token");
    expect(serialized).not.toContain("dsql.us-east-1.on.aws");
    expect(manifest.createdIds).toEqual(Object.fromEntries(SEED_ORDER.map((kind) => [kind, []])));
    expect(manifest.plannedIds.sessions).toHaveLength(1);
    expect(manifest.identity).toMatchObject({ schema: "compass_preview", runId: RUN_ID, deploymentSha: SHA });
  });

  it("writes and reads owner-only regular JSON files", () => {
    const { manifestPath } = tempPaths();
    writePrivateJson(manifestPath, { ok: true });
    expect(fs.statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(readPrivateManifest(manifestPath)).toEqual({ ok: true });
    fs.chmodSync(manifestPath, 0o644);
    expect(() => readPrivateManifest(manifestPath)).toThrow(/owner-only/);
  });

  it("refuses symlinked private state", () => {
    const { manifestPath } = tempPaths();
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const target = path.join(path.dirname(manifestPath), "target.json");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    fs.symlinkSync(target, manifestPath);
    expect(() => readPrivateManifest(manifestPath)).toThrow(/non-symlink/);
  });
});

describe("preview fixture seed and cleanup recovery", () => {
  it("seeds in dependency order with every transaction below the DSQL limit", async () => {
    const store = new RecordingStore();
    const paths = tempPaths();
    const plan = createPlan();
    await seedPreviewFixture({ plan, store, ...paths });

    expect(store.inserts.map(({ kind }) => kind)).toEqual(SEED_ORDER);
    expect(Math.max(...store.inserts.map(({ count }) => count))).toBeLessThanOrEqual(MAX_DSQL_TRANSACTION_ROWS);
    const manifest = readPrivateManifest(paths.manifestPath) as ReturnType<typeof createPreviewFixtureManifest>;
    expect(manifest.status).toBe("ready");
    expect(manifest.createdIds).toEqual(manifest.plannedIds);
    const authText = fs.readFileSync(paths.authStatePath, "utf8");
    expect(JSON.parse(authText).cookies[0].name).toBe("__Secure-authjs.session-token");
    expect(authText).toContain("private-session-token");
    expect(fs.statSync(paths.authStatePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(paths.manifestPath, "utf8")).not.toContain("private-session-token");
  });

  it("cleans in application-safe order, verifies zero residue, and removes recovery state", async () => {
    const store = new RecordingStore();
    const paths = tempPaths();
    await seedPreviewFixture({ plan: createPlan(), store, ...paths });
    store.inserts.length = 0;

    await cleanupPreviewFixture({ store, ...paths });

    expect(store.deletes.map(({ kind }) => kind)).toEqual(CLEANUP_ORDER);
    expect(Math.max(...store.deletes.map(({ count }) => count))).toBeLessThanOrEqual(MAX_DSQL_TRANSACTION_ROWS);
    expect(fs.existsSync(paths.manifestPath)).toBe(false);
    expect(fs.existsSync(paths.authStatePath)).toBe(false);
  });

  it("refuses deletion when ownership cannot be proven", async () => {
    const store = new RecordingStore();
    const paths = tempPaths();
    await seedPreviewFixture({ plan: createPlan(), store, ...paths });
    store.ownershipValid = false;
    store.deletes.length = 0;

    await expect(cleanupPreviewFixture({ store, ...paths })).rejects.toThrow(/ownership mismatch/);
    expect(store.deletes).toEqual([]);
    expect(fs.existsSync(paths.manifestPath)).toBe(true);
    expect(fs.existsSync(paths.authStatePath)).toBe(true);
  });

  it("retains recovery files after partial cleanup or nonzero residue and supports retry", async () => {
    const store = new RecordingStore();
    const paths = tempPaths();
    await seedPreviewFixture({ plan: createPlan(), store, ...paths });
    store.deleteFailureKind = "opportunities";

    await expect(cleanupPreviewFixture({ store, ...paths })).rejects.toThrow(/delete failed/);
    expect(fs.existsSync(paths.manifestPath)).toBe(true);
    expect(fs.existsSync(paths.authStatePath)).toBe(true);

    store.deleteFailureKind = null;
    store.residue = 1;
    await expect(cleanupPreviewFixture({ store, ...paths })).rejects.toThrow(/residue/);
    expect(fs.existsSync(paths.manifestPath)).toBe(true);

    store.residue = 0;
    await expect(cleanupPreviewFixture({ store, ...paths })).resolves.toBeUndefined();
    expect(fs.existsSync(paths.manifestPath)).toBe(false);
  });

  it("attempts cleanup after seed failure and retains recovery state when verification fails", async () => {
    const store = new RecordingStore();
    const paths = tempPaths();
    store.insertFailureKind = "solutions";
    store.residue = 1;
    const cleanupSpy = vi.spyOn(store, "deleteIds");

    await expect(seedPreviewFixture({ plan: createPlan(), store, ...paths })).rejects.toThrow(/insert failed[\s\S]*residue/);
    expect(cleanupSpy).toHaveBeenCalled();
    expect(fs.existsSync(paths.manifestPath)).toBe(true);
  });

  it("never includes the database session token in a seed failure", async () => {
    const store = new RecordingStore();
    const paths = tempPaths();
    store.insertFailureKind = "sessions";
    store.insertFailureMessage = "database rejected private-session-token";
    let message = "";
    try {
      await seedPreviewFixture({ plan: createPlan(), store, ...paths });
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("private-session-token");
  });
});

describe("Prisma preview fixture adapter", () => {
  it("refuses an extant root record whose randomized sentinel does not match", async () => {
    const plan = createPlan();
    const manifest = createPreviewFixtureManifest(plan);
    const prisma = {
      user: {
        findMany: vi.fn(async () => [{ id: manifest.plannedIds.users[0], email: "real-user@example.com" }]),
      },
    } as unknown as PrismaClient;
    const store = new PrismaPreviewFixtureStore(prisma);

    await expect(store.verifyOwnership(manifest)).rejects.toThrow(/user email sentinel/);
    expect(prisma.user.findMany).toHaveBeenCalledOnce();
  });
});
