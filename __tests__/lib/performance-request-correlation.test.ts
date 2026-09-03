import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  createPreviewPerformanceCorrelation,
  PERFORMANCE_INVOCATION_HEADER,
} from "@/lib/performance-request-correlation";

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  VERCEL_ENV: "preview",
  COMPASS_PERF_BASELINE: "1",
  PERF_SERVER_KIND: "vercel-preview",
  PGSCHEMA: "compass",
  PGHOST: "cluster.dsql.us-east-1.on.aws",
});

describe("preview performance request correlation", () => {
  it("creates a fresh opaque invocation ID only for a guarded sample", () => {
    const value = createPreviewPerformanceCorrelation(
      validEnv(),
      "perf_11111111-1111-4111-8111-111111111111",
      () => "22222222-2222-4222-8222-222222222222",
    );
    expect(value).toEqual({
      header: PERFORMANCE_INVOCATION_HEADER,
      invocationId: "perf_inv_22222222222242228222222222222222",
    });
  });

  it.each([
    ["production", { VERCEL_ENV: "production" }],
    ["disabled", { COMPASS_PERF_BASELINE: "0" }],
    ["wrong server", { PERF_SERVER_KIND: "local-production" }],
    ["wrong schema", { PGSCHEMA: "other" }],
    ["non DSQL", { PGHOST: "db.example.com" }],
    ["static credentials", { AWS_ACCESS_KEY_ID: "forbidden" }],
  ])("refuses %s configuration", (_name, override) => {
    expect(createPreviewPerformanceCorrelation(
      { ...validEnv(), ...override },
      "perf_11111111-1111-4111-8111-111111111111",
    )).toBeNull();
  });

  it("refuses malformed or absent run grouping IDs", () => {
    expect(createPreviewPerformanceCorrelation(validEnv(), null)).toBeNull();
    expect(createPreviewPerformanceCorrelation(validEnv(), "perf_shared")).toBeNull();
  });

  it("uses passive headers without interception or cache variance", () => {
    const proxy = fs.readFileSync("proxy.ts", "utf8");
    const collector = fs.readFileSync("e2e/performance/resource-collector.ts", "utf8");
    expect(proxy).not.toMatch(/vary/i);
    expect(collector).not.toContain("Fetch.enable");
    expect(collector).not.toContain("Network.setRequestInterception");
  });
});
