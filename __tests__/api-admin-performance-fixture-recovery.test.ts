import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const execute = vi.fn();
const oidc = vi.fn();
vi.mock("@/lib/preview-performance-fixture-recovery", () => ({ executePreviewFixtureRecovery: execute }));
vi.mock("@vercel/functions/oidc", () => ({ getVercelOidcTokenSync: oidc }));

const SHA = "a".repeat(40);
const DEPLOYMENT = `dpl_${"A".repeat(24)}`;
const HOST = "compass-recovery-rbcodelabs-team.vercel.app";
const SECRET = "migration-secret-with-enough-entropy";

function env() {
  Object.assign(process.env, {
    VERCEL_ENV: "preview", COMPASS_PERF_BASELINE: "1", PERF_SERVER_KIND: "vercel-preview",
    PGSCHEMA: "compass", PGHOST: "cluster.dsql.us-east-1.on.aws",
    AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/preview", AWS_REGION: "us-east-1",
    VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_DEPLOYMENT_ID: DEPLOYMENT, VERCEL_URL: HOST, MIGRATION_SECRET: SECRET,
  });
  for (const key of ["DATABASE_URL", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "VERCEL_OIDC_TOKEN"]) delete process.env[key];
}

function request(action: "cleanup" | "verify" = "verify", secret = SECRET, overrides: Record<string, unknown> = {}) {
  const body = JSON.stringify({ action, expectedSha: SHA, expectedDeploymentId: DEPLOYMENT, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), ...overrides });
  return new NextRequest(`https://${HOST}/api/admin/performance-fixture-recovery`, {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), "x-migration-secret": secret }, body,
  });
}

describe("POST /api/admin/performance-fixture-recovery", () => {
  beforeEach(() => { vi.resetModules(); execute.mockReset().mockResolvedValue({ state: "absent", residue: 0 }); oidc.mockReset().mockReturnValue("request-oidc"); env(); });

  const guardCases: Array<[string, () => void, Record<string, unknown>?]> = [
    ["production", () => { process.env.VERCEL_ENV = "production"; }],
    ["production schema", () => { process.env.PGSCHEMA = "compass_prod"; }],
    ["static credentials", () => { process.env.AWS_ACCESS_KEY_ID = "forbidden"; }],
    ["wrong executor SHA", () => undefined, { expectedSha: "b".repeat(40) }],
    ["wrong executor deployment", () => undefined, { expectedDeploymentId: `dpl_${"B".repeat(24)}` }],
  ];
  it.each(guardCases)("refuses %s before Prisma", async (_label, mutate, overrides = {}) => {
    mutate();
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    const response = await POST(request("verify", SECRET, overrides));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires MIGRATION_SECRET and request-context OIDC", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    expect((await POST(request("verify", "wrong"))).status).toBe(404);
    oidc.mockReturnValueOnce(undefined);
    expect((await POST(request())).status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts only cleanup/verify with no source identity input", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    expect((await POST(request("cleanup"))).status).toBe(200);
    expect(execute).toHaveBeenCalledWith("cleanup");
    expect((await POST(request("verify", SECRET, { runId: "other-run" }))).status).toBe(404);
  });

  it("returns generic no-store failures without logging secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    execute.mockRejectedValueOnce(new Error(`failure ${SECRET}`));
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    const response = await POST(request("cleanup"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
