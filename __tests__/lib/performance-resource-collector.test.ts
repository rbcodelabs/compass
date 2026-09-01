import { afterEach, describe, expect, it, vi } from "vitest";
import type { CDPSession } from "@playwright/test";
import { createResourceCollector, type ResourceMetric } from "../../e2e/performance/resource-collector";

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

const request = (requestId: string, url: string, headers: Record<string, string> = {}, redirectResponse?: object) => ({
  requestId,
  type: "Fetch",
  request: { url, headers },
  redirectResponse,
});

describe("performance CDP resource collector lifecycle", () => {
  afterEach(() => vi.useRealTimers());

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
      cdp.emit("Network.requestWillBeSent", request(requestId, "http://localhost/org/ws/roadmap", { Rsc: "1" }));
      cdp.emit("Network.loadingFinished", { requestId, encodedDataLength: 10 });
    }
    const closing = collector.closeSample("perf_one", { min: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const snapshot = await closing;
    expect(snapshot.resources).toHaveLength(3);
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
});
