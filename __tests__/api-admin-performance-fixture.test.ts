import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const execute = vi.fn();
vi.mock("@/lib/preview-performance-fixture-runtime", () => ({
  executePreviewFixtureAction: execute,
}));

const VALID_SHA = "a".repeat(40);
const VALID_DEPLOYMENT_ID = `dpl_${"A".repeat(24)}`;
const VALID_HOST = "compass-abc123-rbcodelabs-team.vercel.app";
const RUN_ID = `perf_preview_${"b".repeat(32)}`;

function environment(): void {
  process.env.VERCEL_ENV = "preview";
  process.env.COMPASS_PERF_BASELINE = "1";
  process.env.PERF_SERVER_KIND = "vercel-preview";
  process.env.PGSCHEMA = "compass";
  process.env.PGHOST = "cluster.dsql.us-east-1.on.aws";
  process.env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/preview";
  process.env.AWS_REGION = "us-east-1";
  process.env.VERCEL_OIDC_TOKEN = "oidc";
  process.env.VERCEL_GIT_COMMIT_SHA = VALID_SHA;
  process.env.VERCEL_DEPLOYMENT_ID = VALID_DEPLOYMENT_ID;
  process.env.VERCEL_URL = VALID_HOST;
  process.env.MIGRATION_SECRET = "migration-secret-with-enough-entropy";
  delete process.env.DATABASE_URL;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
}

function body(action: "seed" | "cleanup" | "verify" = "verify") {
  const expiresAt = new Date(Date.now() + 20 * 60_000);
  return {
    action,
    runId: RUN_ID,
    expectedSha: VALID_SHA,
    expectedDeploymentId: VALID_DEPLOYMENT_ID,
    expiresAt: expiresAt.toISOString(),
    ...(action === "seed" ? { sessionToken: "s".repeat(64) } : {}),
  };
}

function request(value: unknown, secret: string | null | undefined = process.env.MIGRATION_SECRET): NextRequest {
  const serialized = JSON.stringify(value);
  return new NextRequest(`https://${VALID_HOST}/api/admin/performance-fixture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(serialized)),
      ...(typeof secret === "string" ? { "x-migration-secret": secret } : {}),
    },
    body: serialized,
  });
}

describe("POST /api/admin/performance-fixture", () => {
  beforeEach(() => {
    vi.resetModules();
    execute.mockReset().mockResolvedValue({ state: "absent", residue: 0 });
    environment();
  });

  it.each([
    ["production environment", () => { process.env.VERCEL_ENV = "production"; }],
    ["production schema", () => { process.env.PGSCHEMA = "compass_prod"; }],
    ["database URL", () => { process.env.DATABASE_URL = "postgres://forbidden"; }],
    ["static AWS credentials", () => { process.env.AWS_ACCESS_KEY_ID = "forbidden"; }],
    ["missing OIDC", () => { delete process.env.VERCEL_OIDC_TOKEN; }],
    ["SHA mismatch", () => { process.env.VERCEL_GIT_COMMIT_SHA = "c".repeat(40); }],
    ["deployment mismatch", () => { process.env.VERCEL_DEPLOYMENT_ID = `dpl_${"B".repeat(24)}`; }],
    ["URL mismatch", () => { process.env.VERCEL_URL = "compass-other-rbcodelabs-team.vercel.app"; }],
  ])("returns an indistinguishable 404 for %s before database access", async (_label, mutate) => {
    mutate();
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    const response = await POST(request(body()));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns the same 404 for a missing or wrong secret", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    for (const secret of [null, "wrong-secret"]) {
      const response = await POST(request(body(), secret));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Not found" });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a body larger than 16 KiB before database access", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    const response = await POST(request({ ...body(), padding: "x".repeat(17 * 1024) }));
    expect(response.status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown properties and a session token outside seed", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    for (const value of [{ ...body(), unknown: true }, { ...body("cleanup"), sessionToken: "s".repeat(64) }]) {
      expect((await POST(request(value))).status).toBe(404);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate fields, nested values, coercion, and byte-count mismatches", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    const valid = JSON.stringify(body());
    const malformed = [
      valid.replace('"action":"verify"', '"action":"verify","action":"verify"'),
      JSON.stringify({ ...body(), runId: { value: RUN_ID } }),
      JSON.stringify({ ...body(), expectedDeploymentId: 123 }),
    ];
    for (const serialized of malformed) {
      const req = request(body());
      Object.defineProperty(req, "body", { value: new Response(serialized).body });
      req.headers.set("content-length", String(Buffer.byteLength(serialized)));
      expect((await POST(req)).status).toBe(404);
    }
    const wrongLength = request(body());
    wrongLength.headers.set("content-length", "1");
    expect((await POST(wrongLength)).status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects expired and more-than-30-minute requests before database access", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    for (const expiresAt of [
      new Date(Date.now() - 1_000).toISOString(),
      new Date(Date.now() + 31 * 60_000).toISOString(),
    ]) {
      expect((await POST(request({ ...body(), expiresAt }))).status).toBe(404);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects non-canonical hosts and missing content length", async () => {
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    const aliased = new NextRequest("https://preview.example.com/api/admin/performance-fixture", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(JSON.stringify(body()))), "x-migration-secret": process.env.MIGRATION_SECRET! },
      body: JSON.stringify(body()),
    });
    expect((await POST(aliased)).status).toBe(404);

    const missingLength = request(body());
    missingLength.headers.delete("content-length");
    expect((await POST(missingLength)).status).toBe(404);
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes a valid exact-deployment request without returning a token", async () => {
    execute.mockResolvedValue({ state: "seeded", residue: 1231, replayed: false });
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    const response = await POST(request(body("seed")));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ state: "seeded", residue: 1231, replayed: false });
    expect(JSON.stringify(result)).not.toContain("s".repeat(64));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns a sanitized no-store failure without application logging", async () => {
    const token = "z".repeat(64);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    execute.mockRejectedValueOnce(new Error(`failure ${token}`));
    const { POST } = await import("@/app/api/admin/performance-fixture/route");
    const response = await POST(request({ ...body("seed"), sessionToken: token }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Request failed" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
