import { afterEach, describe, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import {
  createCompletedRscResponseObserver,
  createResourceCollector,
  type ResourceMetric,
} from "../../e2e/performance/resource-collector";

class FakeCdp {
  private handlers = new Map<string, Array<(event: never) => void>>();
  on(event: string, handler: (payload: never) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  async send() { return {}; }
  emit(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload as never);
  }
}

let correlationSequence = 0;
const request = (requestId: string, url: string, headers: Record<string, string> = {}, redirectResponse?: object) => ({
  requestId,
  type: "Fetch",
  wallTime: 1788283200.1,
  request: {
    url,
    headers: {
      "X-Compass-Perf-Request-Id": `perf_00000000-0000-4000-8000-${String(++correlationSequence).padStart(12, "0")}`,
      ...headers,
    },
    method: "GET",
  },
  redirectResponse,
});

describe("performance CDP resource collector lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.PERF_SERVER_KIND;
  });

  it("fails closed when a preview target response has no Vercel invocation ID", async () => {
    vi.useFakeTimers();
    process.env.PERF_SERVER_KIND = "vercel-preview";
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "api", targetPath: "/api/panels/entity/opportunity/", match: "prefix" });
    cdp.emit("Network.requestWillBeSent", request("r1", "http://localhost/api/panels/entity/opportunity/one"));
    cdp.emit("Network.responseReceived", {
      requestId: "r1",
      type: "Fetch",
      response: { url: "http://localhost/api/panels/entity/opportunity/one", mimeType: "application/json", headers: {} },
    });
    const closing = collector.closeSample("perf_one", { exact: 1 });
    await expect(closing).rejects.toThrow(/missing its Vercel invocation ID/);
  });

  it("rejects a tracked loading failure with request context", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("r1", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFailed", { requestId: "r1", errorText: "net::ERR_FAILED", canceled: false });
    const closing = collector.closeSample("perf_one", { exact: 1 });
    const assertion = expect(closing).rejects.toThrow(/r1.*ERR_FAILED/);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it("rejects a target redirect while preserving the initial request owner", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("r1", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.requestWillBeSent", request("r1", "http://localhost/org/ws/roadmap", { Rsc: "1" }, {}));
    await expect(collector.closeSample("perf_one", { exact: 1 })).rejects.toThrow(/redirected/);
  });

  it("observes a delayed duplicate during closing before enforcing exact count", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("r1", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    const closing = collector.closeSample("perf_one", { exact: 1 });
    const assertion = expect(closing).rejects.toThrow(/observed 2/);
    await vi.advanceTimersByTimeAsync(50);
    cdp.emit("Network.requestWillBeSent", request("r2", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it("aggregates every isolated target request when the contract allows navigation fan-out", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    for (const requestId of ["r1", "r2", "r3"]) {
      cdp.emit("Network.requestWillBeSent", request(requestId, "http://localhost/org/ws/roadmap", {
        Rsc: "1",
        "X-Compass-Perf-Request-Id": "perf_11111111-1111-4111-8111-111111111111",
      }));
      cdp.emit("Network.responseReceived", {
        requestId,
        type: "Fetch",
        response: {
          url: "http://localhost/org/ws/roadmap",
          mimeType: "text/x-component",
          headers: { "x-vercel-id": `iad1::${requestId}` },
        },
      });
      cdp.emit("Network.loadingFinished", { requestId, encodedDataLength: 10 });
    }
    const closing = collector.closeSample("perf_one", { min: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = await closing;
    expect(snapshot.resources).toHaveLength(3);
    expect(new Set(snapshot.resources.map((resource) => resource.requestId)).size).toBe(3);
    expect(snapshot.resources[0]).toEqual(expect.objectContaining({
      method: "GET",
      startedAt: "2026-09-01T17:20:00.100Z",
    }));
    expect(snapshot).toEqual(expect.objectContaining({ attemptedCount: 3, completedCount: 3, canceledCount: 0 }));
  });

  it("records canceled RSC attempts while retaining completed fan-out resources", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("canceled", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFailed", { requestId: "canceled", errorText: "net::ERR_ABORTED", canceled: true });
    cdp.emit("Network.requestWillBeSent", request("completed", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFinished", { requestId: "completed", encodedDataLength: 10 });
    const closing = collector.closeSample("perf_one", { min: 1 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toEqual(expect.objectContaining({
      attemptedCount: 2,
      completedCount: 1,
      canceledCount: 1,
    }));
  });

  it("rejects an RSC sample when every qualifying attempt is canceled", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("canceled", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFailed", { requestId: "canceled", errorText: "net::ERR_ABORTED", canceled: true });
    const closing = collector.closeSample("perf_one", { min: 1 });
    const assertion = expect(closing).rejects.toThrow(/no completed RSC.*1 canceled/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });

  it("allows canceled-only speculative RSC attempts for a ready Router Cache sample", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("canceled", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFailed", { requestId: "canceled", errorText: "net::ERR_ABORTED", canceled: true });
    const closing = collector.closeSample("perf_one", { exact: 0, allowCanceledOnly: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toEqual(expect.objectContaining({
      attemptedCount: 1,
      completedCount: 0,
      canceledCount: 1,
    }));
  });

  it("classifies a completed RSC from CDP when the response observer has not settled", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("completed", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFinished", { requestId: "completed", encodedDataLength: 10 });
    const closing = collector.closeSample("perf_one", { warmRsc: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toEqual(expect.objectContaining({
      attemptedCount: 1,
      completedCount: 1,
      canceledCount: 0,
    }));
  });

  it("retains mixed completed and canceled warm RSC fan-out", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const collector = await createResourceCollector(cdp as unknown as CDPSession, []);
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("completed", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFinished", { requestId: "completed", encodedDataLength: 10 });
    cdp.emit("Network.requestWillBeSent", request("canceled", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    cdp.emit("Network.loadingFailed", { requestId: "canceled", errorText: "net::ERR_ABORTED", canceled: true });
    const closing = collector.closeSample("perf_one", { warmRsc: true });
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toEqual(expect.objectContaining({
      attemptedCount: 2,
      completedCount: 1,
      canceledCount: 1,
    }));
  });

  it("waits for completion and returns an immutable snapshot without unrelated traffic", async () => {
    vi.useFakeTimers();
    const cdp = new FakeCdp();
    const resources: ResourceMetric[] = [];
    const collector = await createResourceCollector(cdp as unknown as CDPSession, resources);
    cdp.emit("Network.requestWillBeSent", request("outside", "http://localhost/org/ws/roadmap", {
      Rsc: "1",
      "X-Compass-Perf-Request-Id": "perf_one",
    }));
    collector.beginSample("perf_one", { kind: "rsc", targetPath: "/org/ws/roadmap", match: "exact" });
    cdp.emit("Network.requestWillBeSent", request("asset", "http://localhost/app.js"));
    cdp.emit("Network.requestWillBeSent", request("r1", "http://localhost/org/ws/roadmap", { Rsc: "1" }));
    const closing = collector.closeSample("perf_one", { exact: 1 });
    await vi.advanceTimersByTimeAsync(100);
    cdp.emit("Network.loadingFinished", { requestId: "r1", encodedDataLength: 42 });
    const snapshot = await closing;
    expect(snapshot.resources).toHaveLength(1);
    expect(snapshot.resources[0].url).toBe("http://localhost/org/ws/roadmap");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.resources)).toBe(true);
    expect(Object.isFrozen(snapshot.resources[0])).toBe(true);
  });

  it("does not treat response headers as a completed warm-navigation RSC", async () => {
    let finish!: (result: null | Error) => void;
    const finished = new Promise<null | Error>((resolve) => { finish = resolve; });
    const observer = createCompletedRscResponseObserver("/org/ws/roadmap", () => 42);
    observer.observe({
      url: () => "http://localhost/org/ws/roadmap?_rsc=one",
      request: () => ({ headers: () => ({
        rsc: "1",
        "x-compass-perf-request-id": "perf_11111111-1111-4111-8111-111111111111",
      }) }),
      headers: () => ({ "content-type": "text/x-component" }),
      finished: () => finished,
    });
    finish(new Error("net::ERR_ABORTED"));

    await expect(observer.settle()).resolves.toEqual({ url: null, completedAt: null });
  });

  it("bounds a warm-navigation response whose completion never settles", async () => {
    vi.useFakeTimers();
    const observer = createCompletedRscResponseObserver("/org/ws/roadmap", () => 42);
    observer.observe({
      url: () => "http://localhost/org/ws/roadmap?_rsc=one",
      request: () => ({ headers: () => ({
        rsc: "1",
        "x-compass-perf-request-id": "perf_11111111-1111-4111-8111-111111111111",
      }) }),
      headers: () => ({ "content-type": "text/x-component" }),
      finished: () => new Promise<null | Error>(() => undefined),
    });
    const settling = observer.settle();
    let resolved = false;
    void settling.then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(resolved).toBe(true);
    await expect(settling).resolves.toEqual({ url: null, completedAt: null });
  });
});
