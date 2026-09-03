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
    VERCEL_GIT_COMMIT_SHA: SHA, VERCEL_DEPLOYMENT_ID: DEPLOYMENT, VERCEL_PROJECT_ID: "prj_BofzJ65kFnTykvTkoti7o4hjvxw9", VERCEL_URL: HOST, MIGRATION_SECRET: SECRET,
  });
  for (const key of ["DATABASE_URL", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "VERCEL_OIDC_TOKEN", "COMPASS_PERF_SCHEMA"]) delete process.env[key];
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
    ["malformed executor deployment", () => undefined, { expectedDeploymentId: "not-a-deployment" }],
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

  it("uses project, SHA, and unique host as the runtime composite rather than VERCEL_DEPLOYMENT_ID", async () => {
    process.env.VERCEL_DEPLOYMENT_ID = `dpl_${"Z".repeat(24)}`;
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    expect((await POST(request("verify"))).status).toBe(200);
    expect(execute).toHaveBeenCalledWith("verify");
  });

  it("refuses the wrong immutable Vercel project before Prisma", async () => {
    process.env.VERCEL_PROJECT_ID = "prj_wrong";
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    expect((await POST(request("verify"))).status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
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
    ["baseline", () => { process.env.PGSCHEMA = "compass_prod"; }, "PF_EXEC_BASE"],
    ["SHA", () => { process.env.VERCEL_GIT_COMMIT_SHA = "b".repeat(40); }, "PF_EXEC_SHA"],
    ["deployment ID", () => { process.env.VERCEL_DEPLOYMENT_ID = `dpl_${"B".repeat(24)}`; }, "PF_EXEC_ID"],
    ["URL", () => { process.env.VERCEL_URL = "compass-other-rbcodelabs-team.vercel.app"; }, "PF_EXEC_URL"],
    ["project", () => { process.env.VERCEL_PROJECT_ID = "prj_wrong"; }, "PF_EXEC_PROJECT"],
    ["ready", () => { oidc.mockReturnValue(undefined); }, "PF_EXEC_READY"],
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
    expect(oidc).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it.each([
    ["missing secret", "", {}],
    ["wrong secret", "wrong", {}],
    ["malformed deployment", SECRET, { expectedDeploymentId: "not-a-deployment" }],
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

  it("reports only the URL stage for an alias host", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    expect((await POST(request("diagnose", SECRET, {}, "preview.example.com"))).status).toBe(404);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("PF_EXEC_URL");
    expect(execute).not.toHaveBeenCalled();
    expect(oidc).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("keeps diagnose ahead of and independent from OIDC and every Prisma-capable runtime import", () => {
    const source = fs.readFileSync("app/api/admin/performance-fixture-recovery/route.ts", "utf8");
    const diagnosticReturn = source.indexOf('diagnostic("PF_EXEC_READY")');
    const oidc = source.indexOf("getVercelOidcTokenSync()", source.indexOf("export async function POST"));
    const runtimeImport = source.indexOf('await import("@/lib/preview-performance-fixture-recovery")');
    expect(diagnosticReturn).toBeGreaterThan(0);
    expect(runtimeImport).toBeGreaterThan(diagnosticReturn);
    expect(oidc).toBeGreaterThan(diagnosticReturn);
    expect(source).not.toMatch(/from ["']@\/lib\/db|from ["']@prisma\/client|getPrisma\(/);
  });

  it("treats an invalid performance schema override as a coarse runtime failure", async () => {
    process.env.COMPASS_PERF_SCHEMA = "invalid-schema";
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    const response = await POST(request("diagnose"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("PF_EXEC_BASE");
    expect(execute).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not expose secrets, environment values, request fields, errors, or stacks in diagnostic logs", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    process.env.PGSCHEMA = "compass_prod";
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    await POST(request("diagnose"));
    const output = JSON.stringify(log.mock.calls);
    expect(output).toBe('[["PF_EXEC_BASE"]]');
    for (const forbidden of [SECRET, SHA, DEPLOYMENT, HOST, "PGSCHEMA", "compass_prod", "Error", "stack", "true", "false"]) expect(output).not.toContain(forbidden);
    log.mockRestore();
  });

  it("swallows diagnostic logging failures and preserves the generic response", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => { throw new Error("logger failed"); });
    const { POST } = await import("@/app/api/admin/performance-fixture-recovery/route");
    const response = await POST(request("diagnose"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"error":"Not found"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).toHaveBeenCalledOnce();
    expect(oidc).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it("uses only fixed diagnostic literals and no dynamic console interpolation", () => {
    const source = fs.readFileSync("app/api/admin/performance-fixture-recovery/route.ts", "utf8");
    expect([...source.matchAll(/diagnostic\("(PF_EXEC_(?:BASE|SHA|ID|URL|PROJECT|READY))"\)/g)].map((match) => match[1])).toEqual(["PF_EXEC_BASE", "PF_EXEC_SHA", "PF_EXEC_ID", "PF_EXEC_URL", "PF_EXEC_PROJECT", "PF_EXEC_READY"]);
    expect(source).not.toMatch(/console\.info\([^)]*[+$`]/);
  });
});
