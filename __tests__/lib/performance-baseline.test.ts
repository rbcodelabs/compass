import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  aggregateQueryEvents,
  assertSafeAuthState,
  assertSafeLocalPerformanceDatabase,
  correlateVercelRequests,
  correlateQueryEvents,
  instrumentPgPool,
  normalizeQueryFingerprint,
  parsePerformanceQueryLog,
  parseVercelRequestLog,
  parseVercelQueryEnvelope,
  aggregateDsqlByRequest,
  groupVercelEnvelopes,
  summarizeObserverOverhead,
  initializeLocalPerformanceEnvironment,
  prismaPerformanceDbPushArgs,
  createLocalPerformanceChildEnv,
  resolvePerformanceResourceSampleId,
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
