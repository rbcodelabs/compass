import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  aggregateQueryEvents,
  assertSafeAuthState,
  assertSafeLocalPerformanceDatabase,
  correlateVercelRequests,
  extractCorrelatedBrowserRequests,
  correlateQueryEvents,
  instrumentPgPool,
  normalizeQueryFingerprint,
  parsePerformanceQueryLog,
  parseVercelRequestLog,
  parseVercelQueryEnvelope,
  parseVercelQueryEnvelopes,
  assertVercelPreviewLogContext,
  parseVercelRetainedLogs,
  aggregateDsqlByRequest,
  groupVercelEnvelopes,
  groupVercelRequestLogs,
  aggregateDsqlByPlatformRequest,
  summarizeObserverOverhead,
  initializeLocalPerformanceEnvironment,
  persistPerformanceArtifact,
  prismaPerformanceDbPushArgs,
  createLocalPerformanceChildEnv,
  resolvePerformanceResourceSampleId,
  resolvePerformanceInvocationId,
} from "@/lib/performance-baseline";

describe("performance baseline safeguards", () => {
  const authFile = path.resolve("e2e/performance/.auth/unit-test.json");
  afterEach(() => fs.rmSync(authFile, { force: true }));
  it("attributes only resources in the active serial sample and rejects conflicts", () => {
    expect(resolvePerformanceResourceSampleId(null, "perf_active")).toBe("perf_active");
    expect(resolvePerformanceResourceSampleId("perf_header", null)).toBeNull();
    expect(resolvePerformanceResourceSampleId("perf_same", "perf_same")).toBe("perf_same");
    expect(() => resolvePerformanceResourceSampleId("perf_other", "perf_active")).toThrow(/conflicts/);
  });
  it("accepts only loopback compass databases with an owned performance schema", () => {
    expect(() =>
      assertSafeLocalPerformanceDatabase(
        "postgresql://postgres:postgres@localhost:5437/compass",
        "compass_perf_20260901_ab12"
      )
    ).not.toThrow();

    expect(() =>
      assertSafeLocalPerformanceDatabase(
        "postgresql://admin@example.dsql.us-east-1.on.aws/postgres",
        "compass_perf_20260901_ab12"
      )
    ).toThrow(/loopback/);
    expect(() =>
      assertSafeLocalPerformanceDatabase(
        "postgresql://postgres:postgres@localhost:5437/other",
        "compass_perf_20260901_ab12"
      )
    ).toThrow(/database/);
    expect(() =>
      assertSafeLocalPerformanceDatabase(
        "postgresql://postgres:postgres@localhost:5437/compass",
        "public"
      )
    ).toThrow(/schema/);
  });

  it("establishes the complete local runner environment without caller flags", () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    initializeLocalPerformanceEnvironment(env);
    expect(env).toEqual(expect.objectContaining({
      PERF_SERVER_KIND: "local-production",
      PERF_EXTERNALLY_MANAGED: "1",
      COMPASS_PERF_BASELINE: "1",
    }));
  });

  it("persists successful browser artifacts at a stable ignored path", () => {
    const root = path.resolve(".performance-baseline/unit-test-artifacts");
    fs.rmSync(root, { recursive: true, force: true });

    try {
      const artifactPath = persistPerformanceArtifact("local-production", "navigation", { version: 1 }, root);
      expect(artifactPath).toBe(path.join(root, "local-production-navigation.json"));
      expect(JSON.parse(fs.readFileSync(artifactPath, "utf8"))).toEqual({ version: 1 });
      expect(fs.statSync(artifactPath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes the full navigation matrix timeout and uses safe panel artifact names", () => {
    const spec = fs.readFileSync(path.resolve("e2e/performance/performance-baseline.spec.ts"), "utf8");
    const config = fs.readFileSync(path.resolve("e2e/performance/playwright.config.ts"), "utf8");

    expect(spec).toContain("discardedWarmups: 2");
    expect(spec).toContain("retainedWarmPerRoute: 10");
    expect(spec).toContain("coldPerRoute: 5");
    expect(spec).toContain("const NAVIGATION_TIMEOUT_HEADROOM_MS = 60_000");
    expect(spec).toContain("timeoutHeadroomMs: NAVIGATION_TIMEOUT_HEADROOM_MS");
    expect(spec).toContain("NAVIGATION_WARM_ATTEMPT_COUNT * RESOURCE_COMPLETION_TIMEOUT_MS");
    expect(spec).toContain("NAVIGATION_TOTAL_ATTEMPT_COUNT * RESOURCE_QUIESCENCE_MS");
    expect(spec).toContain("test.setTimeout(NAVIGATION_MATRIX.timeoutMs)");
    expect(config).toContain("timeout: 120_000");
    expect(spec).toContain('artifactName: "panel-roadmap-item"');
    expect(spec).toContain("panel.artifactName");
    expect(spec).not.toContain("`panel-${panel.apiType}`");
  });

  it("uses the installed Prisma 7.8 db-push command shape", () => {
    expect(prismaPerformanceDbPushArgs()).toEqual(["prisma", "db", "push"]);
    expect(prismaPerformanceDbPushArgs()).not.toContain("--skip-generate");
  });

  it("trusts only the exact derived loopback origin for local Auth.js", () => {
    const env = createLocalPerformanceChildEnv({ NODE_ENV: "production", AUTH_TRUST_HOST: "true" }, "http://localhost:5234");
    expect(env.AUTH_URL).toBe("http://localhost:5234");
    expect(env.AUTH_TRUST_HOST).toBeUndefined();
    expect(() => createLocalPerformanceChildEnv({ NODE_ENV: "production" }, "https://example.com")).toThrow(/loopback/);
  });

  it("requires ignored owner-only, non-symlink auth state in the dedicated directory", () => {
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, "{}");
    fs.chmodSync(authFile, 0o600);
    expect(() => assertSafeAuthState(authFile)).not.toThrow();
    fs.chmodSync(authFile, 0o644);
    expect(() => assertSafeAuthState(authFile)).toThrow(/owner-only/);
    expect(() => assertSafeAuthState("/tmp/auth.json")).toThrow(/under/);
  });

  it("normalizes statements without retaining values", () => {
    const fingerprint = normalizeQueryFingerprint(
      `SELECT * FROM "User" WHERE email = 'rick@example.com' AND score > 42 AND id = $1`
    );
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("rick@example.com");
    expect(fingerprint).not.toContain("42");
  });

  it("stabilizes query shapes across owned disposable performance schemas", () => {
    const first = normalizeQueryFingerprint(
      `SELECT * FROM "compass_perf_aaa111"."Task" WHERE "id" = 'first-secret'`,
      "compass_perf_aaa111"
    );
    const second = normalizeQueryFingerprint(
      `SELECT * FROM "compass_perf_bbb222"."Task" WHERE "id" = 'second-secret'`,
      "compass_perf_bbb222"
    );
    const unquotedFirst = normalizeQueryFingerprint(
      "SELECT count(*) FROM compass_perf_aaa111._compass_perf_sentinel",
      "compass_perf_aaa111"
    );
    const unquotedSecond = normalizeQueryFingerprint(
      "SELECT count(*) FROM compass_perf_bbb222._compass_perf_sentinel",
      "compass_perf_bbb222"
    );

    expect(first).toBe(second);
    expect(unquotedFirst).toBe(unquotedSecond);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps different SQL and non-owned schema identities distinguishable", () => {
    expect(normalizeQueryFingerprint(
      `SELECT "id" FROM "compass_perf_aaa111"."Task"`
    )).not.toBe(normalizeQueryFingerprint(
      `SELECT "title" FROM "compass_perf_bbb222"."Task"`
    ));
    expect(normalizeQueryFingerprint(
      `SELECT * FROM "tenant_alpha"."Task"`
    )).not.toBe(normalizeQueryFingerprint(
      `SELECT * FROM "tenant_beta"."Task"`
    ));
    expect(normalizeQueryFingerprint(
      `SELECT * FROM "compass_perf_BAD"."Task"`
    )).not.toBe(normalizeQueryFingerprint(
      `SELECT * FROM "compass_perf_aaa111"."Task"`,
      "compass_perf_aaa111"
    ));
    expect(normalizeQueryFingerprint(
      `SELECT * FROM "compass_perf_other"."Task"`,
      "compass_perf_current"
    )).not.toBe(normalizeQueryFingerprint(
      `SELECT * FROM "compass_perf_another"."Task"`,
      "compass_perf_current"
    ));
    expect(() => normalizeQueryFingerprint("SELECT 1", "public")).toThrow(/owned performance schema/);
  });

  it("persists durable browser and panel provenance fields", () => {
    const spec = fs.readFileSync(path.resolve("e2e/performance/performance-baseline.spec.ts"), "utf8");
    expect(spec.match(/browserEngine:/g)).toHaveLength(1);
    expect(spec.match(/browserVersion:/g)).toHaveLength(1);
    expect(spec.match(/\.\.\.browserProvenance\(page\)/g)).toHaveLength(2);
    expect(spec.match(/buildSha:/g)).toHaveLength(2);
    expect(spec.match(/serverKind:/g)).toHaveLength(2);
  });
});

describe("pg query instrumentation", () => {
  it("counts pool and checked-out-client queries exactly once", async () => {
    const poolQuery = vi.fn(async () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const pool: {
      query: (...args: unknown[]) => Promise<{ rows: { id: number }[]; rowCount: number }>;
      connect: (...args: unknown[]) => Promise<{
        query: (...args: unknown[]) => Promise<{ rows: never[]; rowCount: number }>;
        release: () => void;
      }>;
    } = {
      query: poolQuery,
      connect: vi.fn(async () => ({
        query: clientQuery,
        release: vi.fn(),
      })),
    };
    const events: unknown[] = [];

    instrumentPgPool(pool, (event) => events.push(event), () => 10);
    await pool.query("select 1");
    const client = await pool.connect();
    await client.query("select * from things where id = $1", ["secret"]);

    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({ success: true, rowCount: 1, durationMs: 0 }),
      expect.objectContaining({ success: true, rowCount: 0, durationMs: 0 }),
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("records failures and rethrows the original error", async () => {
    const failure = new Error("database unavailable");
    const pool: {
      query: (...args: unknown[]) => Promise<never>;
      connect: (...args: unknown[]) => Promise<never>;
    } = {
      query: vi.fn(async () => {
        throw failure;
      }),
      connect: vi.fn(async () => { throw new Error("unused"); }),
    };
    const events: Array<{ success: boolean; errorCode?: string }> = [];
    instrumentPgPool(pool, (event) => events.push(event), () => 10);

    await expect(pool.query("select 1")).rejects.toBe(failure);
    expect(events).toEqual([
      expect.objectContaining({ success: false, errorCode: "Error" }),
    ]);
  });

  it("supports callback queries without emitting early or twice", async () => {
    const pool = {
      query: vi.fn((...args: unknown[]) => {
        const callback = args.at(-1) as (error: null, result: { rowCount: number }) => void;
        callback(null, { rowCount: 3 });
      }),
      connect: vi.fn(async () => { throw new Error("unused"); }),
    };
    const events: unknown[] = [];
    let clock = 10;
    instrumentPgPool(pool, (event) => events.push(event), () => clock);

    clock = 12;
    pool.query({ text: "select * from users where id = $1", values: ["secret"] }, () => {});
    expect(events).toEqual([expect.objectContaining({ success: true, rowCount: 3 })]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("does not double count when pool.query delegates to a wrapped client", async () => {
    const client = {
      query: vi.fn(async (...args: unknown[]) => {
        void args;
        return { rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (...args: unknown[]) => client.query(...args)),
    };
    const events: unknown[] = [];
    instrumentPgPool(pool, (event) => events.push(event), () => 10);
    await pool.connect(); // ensures the same client is wrapped
    await pool.query("select 1");
    expect(events).toHaveLength(1);
  });

  it("captures request identity at query start across concurrent completion", async () => {
    const resolvers: Array<() => void> = [];
    const pool = {
      query: vi.fn((...args: unknown[]) => new Promise<{ rowCount: number }>((resolve) => {
        void args;
        resolvers.push(() => resolve({ rowCount: 1 }));
      })),
      connect: vi.fn(),
    };
    const events: Array<{ requestId: string | null }> = [];
    let current = "perf_first";
    instrumentPgPool(
      pool as unknown as Parameters<typeof instrumentPgPool>[0],
      (event) => events.push(event),
      () => 10,
      () => current
    );
    const first = pool.query("select 1");
    current = "perf_second";
    const second = pool.query("select 2");
    current = "lost_context";
    resolvers[1]();
    resolvers[0]();
    await Promise.all([first, second]);
    expect(events.map((event) => event.requestId).sort()).toEqual(["perf_first", "perf_second"]);
  });

  it("wraps Pool.connect callback clients and preserves errors", async () => {
    const client = { query: vi.fn(async (...args: unknown[]) => {
      void args;
      return { rowCount: 1 };
    }) };
    const pool = {
      query: vi.fn(),
      connect: vi.fn((callback: (error: unknown, connected?: { query: typeof client.query }) => void) => {
        callback(null, client);
      }),
    };
    const events: unknown[] = [];
    instrumentPgPool(pool as unknown as Parameters<typeof instrumentPgPool>[0], (event) => events.push(event), () => 10);
    await new Promise<void>((resolve, reject) => {
      pool.connect((error, connected) => {
        if (error) return reject(error);
        connected!.query("select 1").then(() => resolve(), reject);
      });
    });
    expect(events).toHaveLength(1);

    const failure = new Error("connect failed");
    const failingPool = {
      query: vi.fn(),
      connect: vi.fn((callback: (error: unknown) => void) => callback(failure)),
    };
    instrumentPgPool(failingPool as unknown as Parameters<typeof instrumentPgPool>[0], () => undefined);
    await new Promise<void>((resolve) => {
      failingPool.connect((error) => {
        expect(error).toBe(failure);
        resolve();
      });
    });
  });
});

describe("query artifacts", () => {
  it("derives a bounded unique invocation ID from the browser sample and Vercel request", () => {
    const first = resolvePerformanceInvocationId("perf_sample", "iad1::first");
    const second = resolvePerformanceInvocationId("perf_sample", "iad1::second");
    expect(first).toMatch(/^perf_inv_[a-f0-9]{64}$/);
    expect(second).not.toBe(first);
    expect(resolvePerformanceInvocationId("perf_sample", null)).toBe("perf_sample");
  });
  it("expands each browser sample into unique platform-request correlation records", () => {
    const base = {
      requestId: "sample",
      method: "GET",
      path: "/roadmap",
      startedAt: "2026-09-01T12:00:00.000Z",
    };
    const first = { ...base, requestId: "perf_first" };
    const second = { ...base, requestId: "perf_second" };
    expect(extractCorrelatedBrowserRequests([{
      ...base,
      requests: [first, second],
    }]).requests).toEqual([first, second]);
    expect(() => extractCorrelatedBrowserRequests([{
      ...base,
      requests: [first, first],
    }])).toThrow(/unique correlation IDs/);
  });
  it("parses only structured query log lines and aggregates timings", () => {
    const line = `COMPASS_PERF_QUERY {\"version\":1,\"timestamp\":\"2026-09-01T12:00:00.000Z\",\"requestId\":\"perf_1\",\"operation\":\"SELECT\",\"durationMs\":12.5,\"fingerprint\":\"${"a".repeat(64)}\",\"success\":true,\"rowCount\":1}`;
    const event = parsePerformanceQueryLog(line);
    expect(event?.fingerprint).toBe("a".repeat(64));
    expect(parsePerformanceQueryLog("ordinary app log")).toBeNull();
    expect(aggregateQueryEvents([event!, { ...event!, durationMs: 7.5 }])).toEqual(
      expect.objectContaining({ count: 2, totalDurationMs: 20, maxDurationMs: 12.5 })
    );
  });

  it("rejects ambiguous Vercel request correlation", () => {
    const browser = {
      requestId: "perf_sample_1",
      method: "GET",
      path: "/acme/compass/roadmap",
      startedAt: "2026-09-01T12:00:00.000Z",
    };
    const candidate = {
      requestId: "platform_req_1",
      customRequestId: "perf_sample_1",
      method: "GET",
      path: "/acme/compass/roadmap",
      timestamp: "2026-09-01T12:00:00.100Z",
      durationMs: 20,
      statusCode: 200,
    };
    expect(correlateVercelRequests([browser], [candidate])).toHaveLength(1);
    expect(() =>
      correlateVercelRequests([browser], [candidate, { ...candidate }])
    ).toThrow(/ambiguous/);
  });

  it("correlates by exact request evidence when edge and function IDs differ", () => {
    const browser = { requestId: "perf_inv_edge", method: "GET", path: "/roadmap?_rsc=edge", startedAt: "2026-09-01T12:00:00.000Z" };
    const platform = { requestId: "platform_1", customRequestId: "perf_inv_function", method: "GET", path: "/roadmap", timestamp: "2026-09-01T12:00:00.038Z", durationMs: 20, statusCode: 200 };
    expect(correlateVercelRequests([browser], [platform])).toEqual([{ browser, vercel: platform }]);
  });

  it("uses a 500ms inclusive correlation window and rejects adjacent ambiguity", () => {
    const browser = { requestId: "perf_edge", method: "GET", path: "/roadmap?_rsc=edge", startedAt: "2026-09-01T12:00:00.000Z" };
    const candidate = { requestId: "platform_1", customRequestId: "", method: "GET", path: "/roadmap", timestamp: "2026-09-01T12:00:00.500Z", durationMs: 20, statusCode: 200 };
    expect(correlateVercelRequests([browser], [candidate])).toHaveLength(1);
    expect(() => correlateVercelRequests([browser], [candidate, { ...candidate, requestId: "platform_2", timestamp: "2026-09-01T11:59:59.400Z" }])).not.toThrow();
    expect(() => correlateVercelRequests([browser], [candidate, { ...candidate, requestId: "platform_2", timestamp: "2026-09-01T11:59:59.700Z" }])).toThrow(/ambiguous/);
  });

  it("does not reuse one platform invocation for two browser requests", () => {
    const browser = { requestId: "perf_edge_1", method: "GET", path: "/roadmap?_rsc=edge", startedAt: "2026-09-01T12:00:00.000Z" };
    const candidate = { requestId: "platform_1", customRequestId: "", method: "GET", path: "/roadmap", timestamp: "2026-09-01T12:00:00.038Z", durationMs: 20, statusCode: 200 };
    expect(() => correlateVercelRequests([browser, { ...browser, requestId: "perf_edge_2" }], [candidate])).toThrow(/one-to-one/);
  });

  it("groups selected platform logs and DSQL without accepting unrelated traffic", () => {
    const request = { requestId: "platform_1", customRequestId: "", method: "GET", path: "/roadmap", timestamp: "2026-09-01T12:00:00Z", durationMs: 12, statusCode: 200 };
    const event = { version: 1 as const, timestamp: "2026-09-01T12:00:00Z", requestId: "perf_inv_function", operation: "SELECT", fingerprint: "a".repeat(64), durationMs: 2, success: true, rowCount: 1 };
    expect(groupVercelRequestLogs([request, { ...request }])).toEqual([request]);
    expect(aggregateDsqlByPlatformRequest(["platform_1"], [
      { platformRequestId: "platform_1", event },
      { platformRequestId: "unrelated", event: { ...event, requestId: "background" } },
    ])).toEqual([expect.objectContaining({ platformRequestId: "platform_1", customRequestId: "perf_inv_function", count: 1 })]);
    expect(() => aggregateDsqlByPlatformRequest(["platform_1"], [
      { platformRequestId: "platform_1", event },
      { platformRequestId: "platform_1", event: { ...event, requestId: "other" } },
    ])).toThrow(/inconsistent/);
  });

  it("ingests Vercel JSON with separate platform and Compass request IDs", () => {
    const request = parseVercelRequestLog(JSON.stringify({
      requestId: "platform_req_1",
      timestamp: "2026-09-01T12:00:00.100Z",
      durationMs: 22,
      request: {
        method: "GET",
        path: "/acme/compass/roadmap",
        headers: { "x-compass-perf-request-id": "perf_1" },
      },
      response: { statusCode: 200 },
    }));
    expect(request).toEqual(expect.objectContaining({
      requestId: "platform_req_1",
      customRequestId: "perf_1",
      durationMs: 22,
    }));
    expect(parseVercelRequestLog("{bad")).toBeNull();
  });

  it("uses the authoritative Vercel requestPath field", () => {
    const request = parseVercelRequestLog(JSON.stringify({
      requestId: "platform_req_1",
      timestamp: "2026-09-01T12:00:00.100Z",
      durationMs: 22,
      requestPath: "/acme/compass/roadmap",
      requestMethod: "GET",
      statusCode: 200,
    }));
    expect(request).toEqual(expect.objectContaining({
      method: "GET",
      path: "/acme/compass/roadmap",
    }));
  });

  it("parses the retained Vercel CLI serverless envelope without inventing duration", () => {
    const line = JSON.stringify({
      id: "gm98s-1788400459949-41d83ef6154b",
      timestamp: 1788400459949,
      deploymentId: "dpl_One",
      projectId: "prj_One",
      source: "serverless",
      requestMethod: "GET",
      requestPath: "/acme/compass/roadmap",
      responseStatusCode: 200,
      environment: "preview",
      domain: "compass-preview-rbcodelabs-team.vercel.app",
      logs: [{ message: `COMPASS_PERF_QUERY {"version":1,"timestamp":"2026-09-03T01:54:19.950Z","requestId":"perf_inv_function","operation":"SELECT","durationMs":4,"fingerprint":"${"a".repeat(64)}","success":true,"rowCount":1}` }],
    });
    expect(parseVercelRequestLog(line)).toEqual(expect.objectContaining({
      requestId: "gm98s-1788400459949-41d83ef6154b",
      durationMs: null,
      statusCode: 200,
    }));
    expect(parseVercelQueryEnvelopes(line)).toEqual([
      expect.objectContaining({ platformRequestId: "gm98s-1788400459949-41d83ef6154b", event: expect.objectContaining({ requestId: "perf_inv_function" }) }),
    ]);
  });

  it("requires complete consistent preview context when retained CLI metadata is present", () => {
    const base = { requestId: "one", customRequestId: "", method: "GET", path: "/roadmap", timestamp: "2026-09-03T01:54:19.949Z", durationMs: null, statusCode: 200, deploymentId: "dpl_One", projectId: "prj_One", source: "serverless", environment: "preview", domain: "compass-preview-rbcodelabs-team.vercel.app" };
    expect(() => assertVercelPreviewLogContext([base])).not.toThrow();
    expect(() => assertVercelPreviewLogContext([base, { ...base, requestId: "two", environment: "production" }])).toThrow(/context/);
    expect(() => assertVercelPreviewLogContext([base, { ...base, requestId: "two", projectId: undefined }])).toThrow(/context/);
  });

  it("rejects conflicting duplicate platform context before selecting a request", () => {
    const base = { requestId: "platform", customRequestId: "", method: "GET", path: "/roadmap", timestamp: "2026-09-03T01:54:19.949Z", durationMs: null, statusCode: 200, deploymentId: "dpl_One", projectId: "prj_One", source: "serverless", environment: "preview", domain: "one.vercel.app" };
    for (const conflict of [
      { projectId: "prj_Two" },
      { environment: "production" },
      { domain: "two.vercel.app" },
      { deploymentId: undefined },
    ]) expect(() => groupVercelRequestLogs([base, { ...base, ...conflict }])).toThrow(/inconsistent/);
  });

  it("deduplicates complete retained envelopes before counting nested DSQL events", () => {
    const envelope = JSON.stringify({
      id: "platform_1", timestamp: 1788400459949, deploymentId: "dpl_One", projectId: "prj_One",
      source: "serverless", requestMethod: "GET", requestPath: "/roadmap", responseStatusCode: 200,
      environment: "preview", domain: "one.vercel.app",
      logs: [{ message: `COMPASS_PERF_QUERY {"version":1,"timestamp":"2026-09-03T01:54:19.950Z","requestId":"perf_function","operation":"SELECT","durationMs":4,"fingerprint":"${"a".repeat(64)}","success":true,"rowCount":1}` }],
    });
    const parsed = parseVercelRetainedLogs([envelope, envelope]);
    expect(parsed.schemaPath).toBe("observed-cli-metadata");
    expect(parsed.requests).toHaveLength(1);
    expect(aggregateDsqlByPlatformRequest(["platform_1"], parsed.queryEnvelopes)[0].count).toBe(1);
    expect(() => parseVercelRetainedLogs([envelope, envelope.replace('"preview"', '"production"')])).toThrow(/conflicting retained envelopes/);
  });

  it("rejects partial and legacy request records mixed into observed CLI input", () => {
    const observed = JSON.stringify({ id: "platform_1", timestamp: 1788400459949, deploymentId: "dpl_One", projectId: "prj_One", source: "serverless", requestMethod: "GET", requestPath: "/roadmap", responseStatusCode: 200, environment: "preview", domain: "one.vercel.app", logs: [] });
    const partial = JSON.stringify({ id: "platform_2", timestamp: 1788400459950, requestMethod: "GET", requestPath: "/tasks", responseStatusCode: 200 });
    const legacy = JSON.stringify({ requestId: "platform_3", timestamp: 1788400459951, method: "GET", path: "/capture", statusCode: 200, durationMs: 10 });
    expect(() => parseVercelRetainedLogs([observed, partial])).toThrow(/mixed or incomplete/);
    expect(() => parseVercelRetainedLogs([observed, legacy])).toThrow(/mixed or incomplete/);
  });

  it("rejects a standalone partial raw.id record instead of treating it as legacy", () => {
    const partial = JSON.stringify({ id: "platform_partial", timestamp: 1788400459950, requestMethod: "GET", requestPath: "/tasks", responseStatusCode: 200 });
    expect(() => parseVercelRetainedLogs([partial])).toThrow(/mixed or incomplete/);
  });

  it("merges overlapping retained log slices for one immutable platform invocation", () => {
    const query = (id: string, timestamp: string) => ({ timestamp, level: "info", message: `COMPASS_PERF_QUERY {"version":1,"timestamp":"${timestamp}","requestId":"perf_function","operation":"SELECT","durationMs":4,"fingerprint":"${id.repeat(64)}","success":true,"rowCount":1}` });
    const a = query("a", "2026-09-03T01:54:19.950Z");
    const b = query("b", "2026-09-03T01:54:19.951Z");
    const c = query("c", "2026-09-03T01:54:19.952Z");
    const outer = { id: "platform_1", timestamp: 1788400459949, deploymentId: "dpl_One", projectId: "prj_One", source: "serverless", requestMethod: "GET", requestPath: "/roadmap", responseStatusCode: 200, environment: "preview", domain: "one.vercel.app" };
    const parsed = parseVercelRetainedLogs([
      JSON.stringify({ ...outer, logs: [a, b] }),
      JSON.stringify({ ...outer, logs: [b, c] }),
    ]);
    expect(parsed.requests).toHaveLength(1);
    expect(aggregateDsqlByPlatformRequest(["platform_1"], parsed.queryEnvelopes)[0].count).toBe(3);
    expect(() => parseVercelRetainedLogs([
      JSON.stringify({ ...outer, logs: [a] }),
      JSON.stringify({ ...outer, requestPath: "/tasks", logs: [b] }),
    ])).toThrow(/conflicting retained envelopes/);
  });

  it("accepts only contained middleware companion evidence for an authoritative serverless invocation", () => {
    const query = (id: string) => ({ timestamp: `2026-09-03T01:54:19.95${id === "a" ? "0" : "1"}Z`, level: "info", message: `COMPASS_PERF_QUERY {"version":1,"timestamp":"2026-09-03T01:54:19.950Z","requestId":"perf_function","operation":"SELECT","durationMs":4,"fingerprint":"${id.repeat(64)}","success":true,"rowCount":1}` });
    const a = query("a"), b = query("b");
    const outer = { id: "platform_1", timestamp: 1788400459949, deploymentId: "dpl_One", projectId: "prj_One", requestMethod: "GET", requestPath: "/roadmap", responseStatusCode: 200, environment: "preview", domain: "one.vercel.app" };
    const serverless = JSON.stringify({ ...outer, source: "serverless", logs: [a, b] });
    for (const logs of [[a, b], [b]]) {
      const parsed = parseVercelRetainedLogs([serverless, JSON.stringify({ ...outer, source: "serverless-middleware", logs })]);
      expect(parsed.requests).toHaveLength(1);
      expect(parsed.requests[0].source).toBe("serverless");
      expect(parsed.queryEnvelopes).toHaveLength(2);
    }
    const middlewareOnly = parseVercelRetainedLogs([JSON.stringify({ ...outer, source: "serverless-middleware", logs: [a] })]);
    expect(middlewareOnly.requests).toEqual([]);
    expect(middlewareOnly.queryEnvelopes).toEqual([]);
    expect(() => correlateVercelRequests([
      { requestId: "perf_edge", method: "GET", path: "/roadmap", startedAt: "2026-09-03T01:54:19.949Z" },
    ], middlewareOnly.requests)).toThrow(/No Vercel request/);
    expect(() => parseVercelRetainedLogs([serverless, JSON.stringify({ ...outer, source: "serverless-middleware", requestPath: "/tasks", logs: [a] })])).toThrow(/middleware companion/);
    const extra = query("c");
    expect(() => parseVercelRetainedLogs([serverless, JSON.stringify({ ...outer, source: "serverless-middleware", logs: [a, extra] })])).toThrow(/middleware companion/);
    for (const extra of [
      { ...outer, source: "edge", logs: [a] },
      { ...outer, source: "edge", requestPath: "/tasks", logs: [a] },
    ]) expect(() => parseVercelRetainedLogs([serverless, JSON.stringify(extra)])).toThrow(/unsupported same-ID source/);
    expect(parseVercelRetainedLogs([JSON.stringify({ ...outer, id: "noise", source: "edge", logs: [a] })]).requests).toEqual([]);
  });

  it("allows only the phase-specific outer message to differ on a middleware companion", () => {
    const log = { timestamp: "2026-09-03T01:54:19.950Z", level: "info", message: `COMPASS_PERF_QUERY {"version":1,"timestamp":"2026-09-03T01:54:19.950Z","requestId":"perf_function","operation":"SELECT","durationMs":4,"fingerprint":"${"a".repeat(64)}","success":true,"rowCount":1}` };
    const outer = { id: "platform_1", timestamp: 1788400459949, deploymentId: "dpl_One", projectId: "prj_One", requestMethod: "GET", requestPath: "/roadmap", responseStatusCode: 200, environment: "preview", domain: "one.vercel.app", traceId: "trace-one", branch: "branch-one" };
    const serverless = JSON.stringify({ ...outer, source: "serverless", message: "Function invocation", logs: [log] });
    const middleware = JSON.stringify({ ...outer, source: "serverless-middleware", message: "Middleware invocation", logs: [log] });
    expect(parseVercelRetainedLogs([serverless, middleware]).requests).toHaveLength(1);
    expect(() => parseVercelRetainedLogs([
      serverless,
      JSON.stringify({ ...outer, source: "serverless-middleware", message: "Middleware invocation", traceId: "trace-two", logs: [log] }),
    ])).toThrow(/middleware companion/);
    expect(parseVercelRetainedLogs([
      serverless,
      JSON.stringify({ ...outer, source: "serverless", message: "Different authoritative message", logs: [log] }),
    ]).requests).toHaveLength(1);
    expect(() => parseVercelRetainedLogs([
      serverless,
      JSON.stringify({ ...outer, source: "serverless", message: "Different authoritative message", requestPath: "/tasks", logs: [log] }),
    ])).toThrow(/conflicting retained envelopes/);
  });

  it("correlates a browser URL with query parameters to an exact Vercel pathname", () => {
    const browser = {
      requestId: "perf_sample_1",
      method: "GET",
      path: "/api/panels/entity/opportunity/one?orgSlug=acme&workspaceSlug=compass",
      startedAt: "2026-09-01T12:00:00.000Z",
    };
    const candidate = {
      requestId: "platform_req_1",
      customRequestId: "perf_sample_1",
      method: "GET",
      path: "/api/panels/entity/opportunity/one",
      timestamp: "2026-09-01T12:00:00.100Z",
      durationMs: 20,
      statusCode: 200,
    };
    expect(correlateVercelRequests([browser], [candidate])).toHaveLength(1);
    expect(() => correlateVercelRequests([browser], [{
      ...candidate,
      path: "/api/panels/entity/opportunity/one-related",
    }])).toThrow(/No Vercel request/);
  });

  it("parses numeric Vercel timestamps and nested function duration", () => {
    const request = parseVercelRequestLog(JSON.stringify({ timestamp: 1788283200100, requestId: "platform_1", path: "/acme/compass/roadmap", statusCode: 200, proxy: { method: "GET" }, function: { durationMs: 19 }, customRequestId: "perf_1" }));
    expect(request).toEqual(expect.objectContaining({ durationMs: 19, method: "GET" }));
    expect(request?.timestamp).toMatch(/^2026-/);
  });

  it("groups runtime query envelopes by platform and custom request IDs", () => {
    const event = { version: 1, timestamp: "2026-09-01T12:00:00.000Z", requestId: "perf_1", operation: "SELECT", durationMs: 4, fingerprint: "a".repeat(64), success: true, rowCount: 1 };
    const envelope = parseVercelQueryEnvelope(JSON.stringify({ requestId: "platform_1", message: "COMPASS_PERF_QUERY " + JSON.stringify(event) }))!;
    expect(aggregateDsqlByRequest(["perf_1"], [envelope])).toEqual([expect.objectContaining({ customRequestId: "perf_1", platformRequestId: "platform_1", count: 1 })]);
    expect(() => aggregateDsqlByRequest(["perf_1", "perf_2"], [envelope, { ...envelope, event: { ...envelope.event, requestId: "perf_2" } }])).toThrow(/inconsistent/);
  });

  it("reduces Vercel envelopes to one consistent authoritative invocation", () => {
    const request = { requestId: "platform_1", customRequestId: "", method: "GET", path: "/roadmap", timestamp: "2026-09-01T12:00:00Z", durationMs: 12, statusCode: 200 };
    const event = { version: 1 as const, timestamp: "2026-09-01T12:00:00Z", requestId: "perf_1", operation: "SELECT", fingerprint: "a".repeat(64), durationMs: 2, success: true, rowCount: 1 };
    expect(groupVercelEnvelopes([request], [{ platformRequestId: "platform_1", event }], ["perf_1"])).toEqual([expect.objectContaining({ customRequestId: "perf_1", durationMs: 12 })]);
    expect(() => groupVercelEnvelopes([request, { ...request, statusCode: 500 }], [{ platformRequestId: "platform_1", event }], ["perf_1"])).toThrow(/inconsistent/);
    const unrelated = { ...request, requestId: "platform_other" };
    const unrelatedEvent = { ...event, requestId: "background" };
    expect(groupVercelEnvelopes([request, unrelated], [{ platformRequestId: "platform_1", event }, { platformRequestId: "platform_other", event: unrelatedEvent }], ["perf_1"])).toHaveLength(1);
  });

  it("summarizes paired observer overhead samples", () => {
    expect(summarizeObserverOverhead([1, 2, 3], [2, 3, 5])).toEqual(expect.objectContaining({ version: 1, sampleCount: 3, medianDeltaMs: 1, p95DeltaMs: 2 }));
    expect(() => summarizeObserverOverhead([1], [])).toThrow(/paired/);
  });

  it("requires every query event to have one known request ID", () => {
    const event = parsePerformanceQueryLog(
      `COMPASS_PERF_QUERY {"version":1,"timestamp":"2026-09-01T12:00:00.000Z","requestId":"perf_1","operation":"SELECT","durationMs":1,"fingerprint":"${"a".repeat(64)}","success":true,"rowCount":1}`
    )!;
    expect(correlateQueryEvents(["perf_1"], [event]).get("perf_1")).toHaveLength(1);
    expect(correlateQueryEvents(["perf_1"], [{ ...event, requestId: null }]).get("perf_1")).toEqual([]);
    expect(correlateQueryEvents(["perf_1"], [{ ...event, requestId: "background" }]).get("perf_1")).toEqual([]);
  });
});
