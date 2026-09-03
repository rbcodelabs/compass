import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  createPreviewPerformanceCorrelation,
  createServerOwnedPerformanceHeaders,
  currentPerformanceInvocation,
  runWithPerformanceInvocation,
  authenticateProxyObservedPerformanceCorrelation,
  PERFORMANCE_INVOCATION_HEADER,
} from "@/lib/performance-request-correlation";

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  VERCEL_ENV: "preview",
  COMPASS_PERF_BASELINE: "1",
  PERF_SERVER_KIND: "vercel-preview",
  PGSCHEMA: "compass",
  PGHOST: "cluster.dsql.us-east-1.on.aws",
  VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  VERCEL_DEPLOYMENT_ID: `dpl_${"A".repeat(24)}`,
  VERCEL_OIDC_TOKEN: "oidc-runtime-signal",
  MIGRATION_SECRET: "migration-secret-with-enough-entropy",
});

describe("preview performance request correlation", () => {
  it("creates a fresh opaque invocation ID only for a guarded sample", () => {
    const value = createPreviewPerformanceCorrelation(
      validEnv(),
      "perf_11111111-1111-4111-8111-111111111111",
      "a".repeat(40),
      "GET", "/roadmap", 1_788_283_200_000,
      () => "22222222222242228222222222222222",
    );
    expect(value).toEqual({
      header: PERFORMANCE_INVOCATION_HEADER,
      invocationId: "perf_inv_22222222222242228222222222222222",
      issuedAt: "1788283200000",
      method: "GET",
      pathname: "/roadmap",
      tag: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    ["production", { VERCEL_ENV: "production" }],
    ["disabled", { COMPASS_PERF_BASELINE: "0" }],
    ["wrong server", { PERF_SERVER_KIND: "local-production" }],
    ["wrong schema", { PGSCHEMA: "other" }],
    ["non DSQL", { PGHOST: "db.example.com" }],
    ["static credentials", { AWS_ACCESS_KEY_ID: "forbidden" }],
    ["missing runtime SHA", { VERCEL_GIT_COMMIT_SHA: undefined }],
    ["missing OIDC", { VERCEL_OIDC_TOKEN: undefined }],
  ])("refuses %s configuration", (_name, override) => {
    expect(createPreviewPerformanceCorrelation(
      { ...validEnv(), ...override },
      "perf_11111111-1111-4111-8111-111111111111",
      "a".repeat(40),
    )).toBeNull();
  });

  it("refuses malformed or absent run grouping IDs", () => {
    expect(createPreviewPerformanceCorrelation(validEnv(), null, "a".repeat(40))).toBeNull();
    expect(createPreviewPerformanceCorrelation(validEnv(), "perf_shared", "a".repeat(40))).toBeNull();
    expect(createPreviewPerformanceCorrelation(validEnv(), "perf_11111111-1111-4111-8111-111111111111", "b".repeat(40))).toBeNull();
  });

  it.each([null, "missing-sample", "disabled"])("strips a spoofed invocation ID when correlation is %s", () => {
    const incoming = new Headers({ [PERFORMANCE_INVOCATION_HEADER]: "perf_inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(createServerOwnedPerformanceHeaders(incoming, null).has(PERFORMANCE_INVOCATION_HEADER)).toBe(false);
  });

  it("replaces a spoofed invocation ID with the generated server-owned value", () => {
    const incoming = new Headers({ [PERFORMANCE_INVOCATION_HEADER]: "perf_inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const headers = createServerOwnedPerformanceHeaders(incoming, {
      invocationId: "perf_inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      header: PERFORMANCE_INVOCATION_HEADER,
      issuedAt: "1788283200000",
      tag: "c".repeat(64),
      method: "GET",
      pathname: "/roadmap",
    });
    expect(headers.get(PERFORMANCE_INVOCATION_HEADER)).toBe("perf_inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("auth and adapter work inside middleware-local correlation without cross-request bleed", async () => {
    const seen = await Promise.all(["perf_inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "perf_inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"].map(
      (id) => runWithPerformanceInvocation(id, async () => {
        await Promise.resolve();
        return currentPerformanceInvocation();
      }),
    ));
    expect(seen).toEqual(["perf_inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "perf_inv_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
    expect(currentPerformanceInvocation()).toBeNull();
  });

  it("authenticates proxy-observed identity and rejects tamper, expiry, method, path, SHA, and deployment changes", () => {
    const now = 1_788_283_200_000;
    const correlation = createPreviewPerformanceCorrelation(
      validEnv(), "perf_11111111-1111-4111-8111-111111111111", "a".repeat(40),
      "GET", "/roadmap", now, () => "1".repeat(32),
    )!;
    const headers = createServerOwnedPerformanceHeaders(new Headers(), correlation);
    expect(authenticateProxyObservedPerformanceCorrelation(validEnv(), headers, now + 1, "GET", "/roadmap")).toBe(correlation.invocationId);
    expect(authenticateProxyObservedPerformanceCorrelation(validEnv(), headers, now + 30_001, "GET", "/roadmap")).toBeNull();
    expect(authenticateProxyObservedPerformanceCorrelation(validEnv(), headers, now + 1, "POST", "/roadmap")).toBeNull();
    expect(authenticateProxyObservedPerformanceCorrelation(validEnv(), headers, now + 1, "GET", "/tasks")).toBeNull();
    expect(authenticateProxyObservedPerformanceCorrelation({ ...validEnv(), VERCEL_GIT_COMMIT_SHA: "b".repeat(40) }, headers, now + 1, "GET", "/roadmap")).toBeNull();
    expect(authenticateProxyObservedPerformanceCorrelation({ ...validEnv(), VERCEL_DEPLOYMENT_ID: `dpl_${"B".repeat(24)}` }, headers, now + 1, "GET", "/roadmap")).toBeNull();
    const tampered = new Headers(headers);
    tampered.set("x-compass-perf-tag", "0".repeat(64));
    expect(authenticateProxyObservedPerformanceCorrelation(validEnv(), tampered, now + 1, "GET", "/roadmap")).toBeNull();
  });

  it("uses passive headers without interception or cache variance", () => {
    const proxy = fs.readFileSync("proxy.ts", "utf8");
    const collector = fs.readFileSync("e2e/performance/resource-collector.ts", "utf8");
    expect(proxy).not.toMatch(/vary/i);
    expect(collector).not.toContain("Fetch.enable");
    expect(collector).not.toContain("Network.setRequestInterception");
  });
});
