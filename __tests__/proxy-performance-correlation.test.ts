import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ adapterQueryId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: (callback: (request: NextRequest & { auth?: object }) => Response) =>
    async (request: NextRequest) => {
      const { currentPerformanceInvocation } = await import("@/lib/performance-request-correlation");
      state.adapterQueryId = currentPerformanceInvocation();
      return callback(Object.assign(request, { auth: {} }));
    },
}));
vi.mock("@/lib/route-access", () => ({ isPublicPath: () => false }));

const env = {
  NODE_ENV: "production", VERCEL_ENV: "preview", COMPASS_PERF_BASELINE: "1", PERF_SERVER_KIND: "vercel-preview",
  PGSCHEMA: "compass", PGHOST: "cluster.dsql.us-east-1.on.aws", VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  VERCEL_DEPLOYMENT_ID: `dpl_${"A".repeat(24)}`, VERCEL_OIDC_TOKEN: "oidc", MIGRATION_SECRET: "migration-secret-with-enough-entropy",
};

describe("outer performance proxy correlation", () => {
  beforeEach(() => { Object.assign(process.env, env); state.adapterQueryId = null; });
  afterEach(() => { for (const key of Object.keys(env)) delete process.env[key]; });

  it("places Auth adapter work inside ALS and replaces a spoofed caller ID", async () => {
    const { proxy } = await import("../proxy");
    const request = new NextRequest("https://exact.vercel.app/roadmap", { headers: {
      "x-compass-perf-request-id": "perf_11111111-1111-4111-8111-111111111111",
      "x-compass-perf-build-sha": "a".repeat(40),
      "x-compass-perf-invocation-id": `perf_inv_${"f".repeat(32)}`,
    }});
    const response = await proxy(request, {} as never);
    expect(state.adapterQueryId).toMatch(/^perf_inv_[a-f0-9]{32}$/);
    expect(state.adapterQueryId).not.toBe(`perf_inv_${"f".repeat(32)}`);
    expect(response.headers.get("x-compass-perf-invocation-id")).toBe(state.adapterQueryId);
    expect(response.headers.has("vary")).toBe(false);
  });

  it("does not expose caller spoofing without a valid measured sample", async () => {
    const { proxy } = await import("../proxy");
    const response = await proxy(new NextRequest("https://exact.vercel.app/roadmap", { headers: {
      "x-compass-perf-invocation-id": `perf_inv_${"f".repeat(32)}`,
    }}), {} as never);
    expect(state.adapterQueryId).toBeNull();
    expect(response.headers.has("x-compass-perf-invocation-id")).toBe(false);
  });
});
