import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "node:fs";

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

function request(action: "cleanup" | "verify" | "diagnose" = "verify", secret = SECRET, overrides: Record<string, unknown> = {}, host = HOST) {
  const body = JSON.stringify({ action, expectedSha: SHA, expectedDeploymentId: DEPLOYMENT, expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), ...overrides });
  return new NextRequest(`https://${host}/api/admin/performance-fixture-recovery`, {
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

  it.each([
    ["production runtime", () => { process.env.VERCEL_ENV = "production"; }, "PF_DIAG_RUNTIME"],
    ["schema runtime", () => { process.env.PGSCHEMA = "compass_prod"; }, "PF_DIAG_RUNTIME"],
    ["static-credential runtime", () => { process.env.AWS_ACCESS_KEY_ID = "forbidden"; }, "PF_DIAG_RUNTIME"],
    ["DSQL runtime", () => { process.env.PGHOST = "postgres.example.com"; }, "PF_DIAG_RUNTIME"],
    ["oidc", () => { oidc.mockReturnValue(undefined); }, "PF_DIAG_OIDC"],
    ["ready", () => undefined, "PF_DIAG_READY"],
  ])("returns the byte-identical 404 and emits only the %s code", async (_label, mutate, code) => {
    mutate();
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    const response = await POST(request("diagnose"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(code);
    expect(execute).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    ["missing secret", "", {}],
    ["wrong secret", "wrong", {}],
    ["wrong SHA", SECRET, { expectedSha: "b".repeat(40) }],
    ["wrong deployment", SECRET, { expectedDeploymentId: `dpl_${"B".repeat(24)}` }],
    ["expired", SECRET, { expiresAt: new Date(Date.now() - 1_000).toISOString() }],
    ["unknown field", SECRET, { runId: "other" }],
  ])("logs nothing for diagnose with %s", async (_label, secret, overrides) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    const response = await POST(request("diagnose", secret, overrides));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found"}');
    expect(log).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(oidc).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("logs nothing for an alias host", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    expect((await POST(request("diagnose", SECRET, {}, "preview.example.com"))).status).toBe(404);
    expect(log).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(oidc).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("keeps diagnose ahead of and independent from every Prisma-capable runtime import", () => {
    const source = fs.readFileSync("app/api/admin/performance-fixture-recovery/route.ts", "utf8");
    const diagnosticReturn = source.indexOf('console.info("PF_DIAG_READY")');
    const runtimeImport = source.indexOf('await import("@/lib/preview-performance-fixture-recovery")');
    expect(diagnosticReturn).toBeGreaterThan(0);
    expect(runtimeImport).toBeGreaterThan(diagnosticReturn);
    expect(source).not.toMatch(/from ["']@\/lib\/db|from ["']@prisma\/client|getPrisma\(/);
  });

  it("does not expose secrets, environment values, request fields, errors, or stacks in diagnostic logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    process.env.PGSCHEMA = "compass_prod";
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    await POST(request("diagnose"));
    const output = JSON.stringify(log.mock.calls);
    expect(output).toBe('[["PF_DIAG_RUNTIME"]]');
    for (const forbidden of [SECRET, SHA, DEPLOYMENT, HOST, "PGSCHEMA", "compass_prod", "Error", "stack", "true", "false"]) expect(output).not.toContain(forbidden);
    log.mockRestore();
  });
});
