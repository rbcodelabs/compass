import type { CDPSession } from "@playwright/test";
import { resolvePerformanceResourceSampleId } from "../../lib/performance-baseline";

export type ResourceMetric = {
  sampleId: string | null;
  kind: "document" | "rsc" | "api";
  url: string;
  cdpEncodedDataLength: number;
  cdpDecodedDataLength: number;
};

export type ResourceContract = {
  kind: ResourceMetric["kind"];
  targetPath: string;
  match: "exact" | "prefix";
};

export type ResourceExpectation =
  | { exact: number; allowCanceledOnly?: boolean }
  | { min: number; max?: number };

export type ResourceSnapshot = {
  resources: ReadonlyArray<Readonly<ResourceMetric>>;
  attemptedCount: number;
  completedCount: number;
  canceledCount: number;
};

const QUIESCENCE_MS = 100;
const COMPLETION_TIMEOUT_MS = 5_000;

export function createCompletedRscResponseObserver(
  sampleId: string,
  targetPath: string,
  now: () => number = () => performance.now()
) {
  let completedUrl: string | null = null;
  let completedAt: number | null = null;
  const pending: Promise<void>[] = [];

  return {
    observe(response: {
      url: () => string;
      request: () => { headers: () => Record<string, string> };
      headers: () => Record<string, string>;
      finished: () => Promise<null | Error>;
    }) {
      const requestHeaders = normalizeHeaders(response.request().headers());
      const responseHeaders = normalizeHeaders(response.headers());
      if (
        requestHeaders["x-compass-perf-request-id"] !== sampleId ||
        !(requestHeaders.rsc === "1" || responseHeaders["content-type"]?.includes("text/x-component")) ||
        new URL(response.url()).pathname !== targetPath
      ) return;

      pending.push(response.finished().then((error) => {
        if (error === null && completedUrl === null) {
          completedUrl = response.url();
          completedAt = now();
        }
      }, () => undefined));
    },
    async settle() {
      await Promise.all(pending);
      return { url: completedUrl, completedAt };
    },
  };
}

function normalizeHeaders(headers: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)])
  );
}

export async function createResourceCollector(cdp: CDPSession, resources: ResourceMetric[]) {
  type Kind = ResourceMetric["kind"];
  type TrackedRequest = {
    url: string;
    decodedBytes: number;
    sampleId: string;
    kind: Kind;
    completed: Promise<void>;
    complete: () => void;
    error: Error | null;
    canceled: boolean;
  };
  type ActiveSample = {
    sampleId: string;
    contract: ResourceContract;
    requestIds: Set<string>;
    phase: "open" | "closing";
    activityVersion: number;
  };

  const requests = new Map<string, TrackedRequest>();
  const requestHeaders = new Map<string, Record<string, string>>();
  const requestWindowOwners = new Map<string, string | null>();
  let active: ActiveSample | null = null;
  let attributionError: Error | null = null;

  const kindFor = (url: string, type: string, headers: Record<string, string>, mimeType = ""): Kind | null =>
    headers.rsc === "1" || mimeType.includes("x-component")
      ? "rsc"
      : url.includes("/api/panels/entity/")
        ? "api"
        : type === "Document"
          ? "document"
          : null;
  const qualifies = (contract: ResourceContract, kind: Kind | null, url: string) => {
    if (kind !== contract.kind) return false;
    const pathname = new URL(url).pathname;
    return contract.match === "exact"
      ? pathname === contract.targetPath
      : pathname.startsWith(contract.targetPath);
  };
  const track = (requestId: string, url: string, kind: Kind, headers: Record<string, string>) => {
    if (!active || !qualifies(active.contract, kind, url) || requests.has(requestId)) return;
    const headerSampleId = headers["x-compass-perf-request-id"] || null;
    try {
      const sampleId = resolvePerformanceResourceSampleId(headerSampleId, active.sampleId);
      if (!sampleId) return;
      let complete!: () => void;
      const completed = new Promise<void>((resolve) => { complete = resolve; });
      requests.set(requestId, { url, decodedBytes: 0, sampleId, kind, completed, complete, error: null, canceled: false });
      active.requestIds.add(requestId);
      active.activityVersion += 1;
    } catch (error) {
      attributionError = error instanceof Error ? error : new Error(String(error));
    }
  };

  cdp.on("Network.requestWillBeSent", ({ requestId, request, type, redirectResponse }) => {
    const headers = normalizeHeaders(request.headers);
    requestHeaders.set(requestId, headers);
    if (!requestWindowOwners.has(requestId)) {
      requestWindowOwners.set(requestId, active?.sampleId ?? null);
    }
    const kind = kindFor(request.url, type ?? "", headers);
    if (redirectResponse && active && (
      requests.has(requestId) ||
      (requestWindowOwners.get(requestId) === active.sampleId && qualifies(active.contract, kind, request.url))
    )) {
      attributionError = new Error(
        `Tracked target request ${requestId} redirected to ${request.url}; redirected samples are unsupported`
      );
      return;
    }
    if (requestWindowOwners.get(requestId) === active?.sampleId && kind) {
      track(requestId, request.url, kind, headers);
    }
  });
  cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
    const headers = requestHeaders.get(requestId) ?? normalizeHeaders(response.requestHeaders ?? {});
    const kind = kindFor(response.url, type, headers, String(response.mimeType));
    if (kind && requestWindowOwners.get(requestId) === active?.sampleId) {
      track(requestId, response.url, kind, headers);
    }
  });
  cdp.on("Network.dataReceived", ({ requestId, dataLength }) => {
    const request = requests.get(requestId);
    if (request) request.decodedBytes += dataLength;
  });
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const request = requests.get(requestId);
    if (!request) return;
    resources.push({
      url: request.url,
      sampleId: request.sampleId,
      kind: request.kind,
      cdpDecodedDataLength: request.decodedBytes,
      cdpEncodedDataLength: encodedDataLength,
    });
    request.complete();
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText, canceled, blockedReason }) => {
    const request = requests.get(requestId);
    if (!request) return;
    request.canceled = canceled === true;
    if (!(request.kind === "rsc" && request.canceled)) {
      request.error = new Error(
        `Tracked ${request.kind} request ${requestId} failed for ${request.url}: ${errorText}` +
        `${request.canceled ? " (canceled)" : ""}${blockedReason ? ` (${blockedReason})` : ""}`
      );
    }
    request.complete();
  });
  await cdp.send("Network.enable");

  const waitForQuiescence = async (sample: ActiveSample) => {
    while (true) {
      const version = sample.activityVersion;
      await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_MS));
      if (sample.activityVersion === version) return;
    }
  };

  return {
    beginSample(sampleId: string, contract: ResourceContract) {
      if (active) throw new Error(`Resource sample ${active.sampleId} is still active`);
      if (attributionError) throw attributionError;
      active = { sampleId, contract, requestIds: new Set(), phase: "open", activityVersion: 0 };
    },
    async closeSample(sampleId: string, expectation: ResourceExpectation): Promise<ResourceSnapshot> {
      if (attributionError) throw attributionError;
      if (active?.sampleId !== sampleId) throw new Error(`Resource sample ${sampleId} is not active`);
      const sample = active;
      sample.phase = "closing";
      await waitForQuiescence(sample);
      if (attributionError) throw attributionError;
      active = null;
      const requestIds = [...sample.requestIds];
      const validCount = "exact" in expectation
        ? requestIds.length === expectation.exact || expectation.allowCanceledOnly === true
        : requestIds.length >= expectation.min &&
          (expectation.max === undefined || requestIds.length <= expectation.max);
      if (!validCount) {
        const expected = "exact" in expectation
          ? `exactly ${expectation.exact}`
          : `at least ${expectation.min}${expectation.max === undefined ? "" : ` and at most ${expectation.max}`}`;
        throw new Error(`Resource sample ${sampleId} expected ${expected} qualifying request(s), observed ${requestIds.length}`);
      }
      await Promise.all(requestIds.map(async (requestId) => {
        const request = requests.get(requestId)!;
        await Promise.race([
          request.completed,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error(`Timed out waiting for ${request.kind} request ${requestId} to complete: ${request.url}`)),
            COMPLETION_TIMEOUT_MS
          )),
        ]);
        if (request.error) throw request.error;
      }));
      const sampleResources = Object.freeze(resources
        .filter((resource) => resource.sampleId === sampleId)
        .map((resource) => Object.freeze({ ...resource })));
      const canceledCount = requestIds.filter((requestId) => requests.get(requestId)!.canceled).length;
      if (
        "exact" in expectation &&
        expectation.allowCanceledOnly &&
        requestIds.length !== expectation.exact &&
        !(sample.contract.kind === "rsc" && sampleResources.length === 0 && canceledCount === requestIds.length)
      ) {
        throw new Error(
          `Resource sample ${sampleId} expected ${expectation.exact} completed request(s) or canceled-only RSC attempts; ` +
          `observed ${sampleResources.length} completed and ${canceledCount} canceled`
        );
      }
      if (sample.contract.kind === "rsc" && requestIds.length > 0 && sampleResources.length === 0) {
        if (!("exact" in expectation && expectation.allowCanceledOnly)) {
          throw new Error(`Resource sample ${sampleId} had no completed RSC requests (${canceledCount} canceled)`);
        }
      }
      return Object.freeze({
        resources: sampleResources,
        attemptedCount: requestIds.length,
        completedCount: sampleResources.length,
        canceledCount,
      });
    },
  };
}
