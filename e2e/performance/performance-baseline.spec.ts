import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";
import { persistPerformanceArtifact } from "../../lib/performance-baseline";
import { ROUTES, expect, test, type PerformanceRoute } from "./fixtures";
import {
  createCompletedRscResponseObserver,
  createResourceCollector,
  RESOURCE_COMPLETION_TIMEOUT_MS,
  RESOURCE_QUIESCENCE_MS,
  type ResourceMetric,
} from "./resource-collector";
type ClientMetric = {
  longTaskSupported: boolean;
  eventTimingSupported: boolean;
  heapSupported: boolean;
  longTaskCount: number | null;
  longTaskTotalMs: number | null;
  maxEventMs: number | null;
  heapBytes: number | null;
};

const NAVIGATION_SAMPLE_COUNTS = {
  discardedWarmups: 2,
  retainedWarmPerRoute: 10,
  coldPerRoute: 5,
} as const;
const NAVIGATION_WARM_ATTEMPT_COUNT = NAVIGATION_SAMPLE_COUNTS.discardedWarmups +
  ROUTES.length * NAVIGATION_SAMPLE_COUNTS.retainedWarmPerRoute;
const NAVIGATION_TOTAL_ATTEMPT_COUNT = NAVIGATION_WARM_ATTEMPT_COUNT +
  ROUTES.length * NAVIGATION_SAMPLE_COUNTS.coldPerRoute;
const NAVIGATION_TIMEOUT_HEADROOM_MS = 60_000;
const NAVIGATION_MATRIX = {
  ...NAVIGATION_SAMPLE_COUNTS,
  timeoutHeadroomMs: NAVIGATION_TIMEOUT_HEADROOM_MS,
  timeoutMs: NAVIGATION_WARM_ATTEMPT_COUNT * RESOURCE_COMPLETION_TIMEOUT_MS +
    NAVIGATION_TOTAL_ATTEMPT_COUNT * RESOURCE_QUIESCENCE_MS +
    NAVIGATION_TIMEOUT_HEADROOM_MS,
} as const;

const durationSummary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { sampleCount: sorted.length, medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
};
const groupedNavigationSummary = (samples: Array<{ route: string; durationMs: number; networkOutcome?: string }>) =>
  Object.fromEntries([...new Set(samples.map((sample) => sample.route))].map((route) => [route, {
    overall: durationSummary(samples.filter((sample) => sample.route === route).map((sample) => sample.durationMs)),
    byNetworkOutcome: Object.fromEntries([...new Set(samples.filter((sample) => sample.route === route).map((sample) => sample.networkOutcome ?? "document"))].map((outcome) => [outcome, durationSummary(samples.filter((sample) => sample.route === route && (sample.networkOutcome ?? "document") === outcome).map((sample) => sample.durationMs))])),
  }]));

const correlatedRequests = (resources: ReadonlyArray<ResourceMetric>) => resources.map((resource) => ({
  requestId: resource.requestId,
  cdpRequestId: resource.cdpRequestId,
  method: resource.method,
  statusCode: resource.statusCode,
  path: new URL(resource.url).pathname + new URL(resource.url).search,
  startedAt: resource.startedAt,
  responseHeaders: resource.responseHeaders,
}));

async function installClientObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      longTasks: [] as number[],
      events: [] as number[],
      observers: [] as PerformanceObserver[],
    };
    Object.assign(window, { __compassPerf: state });
    for (const [type, key] of [["longtask", "longTasks"], ["event", "events"]] as const) {
      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state[key].push(entry.duration);
        });
        observer.observe({ type, buffered: true });
        state.observers.push(observer);
      } catch {
        // Capability is represented as unsupported/null in the artifact.
      }
    }
  });
}

async function readClientMetrics(page: Page, disconnect = true): Promise<ClientMetric> {
  return page.evaluate((shouldDisconnect) => {
    const state = (window as unknown as { __compassPerf: {
      longTasks: number[]; events: number[]; observers: PerformanceObserver[];
    }}).__compassPerf;
    if (shouldDisconnect) state.observers.forEach((observer) => observer.disconnect());
    const supported = PerformanceObserver.supportedEntryTypes;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const result = {
      longTaskSupported: supported.includes("longtask"),
      eventTimingSupported: supported.includes("event"),
      heapSupported: !!memory,
      longTaskCount: supported.includes("longtask") ? state.longTasks.length : null,
      longTaskTotalMs: supported.includes("longtask") ? state.longTasks.reduce((a, b) => a + b, 0) : null,
      maxEventMs: supported.includes("event") && state.events.length ? Math.max(...state.events) : null,
      heapBytes: memory?.usedJSHeapSize ?? null,
    };
    state.longTasks.length = 0;
    state.events.length = 0;
    return result;
  }, disconnect);
}

async function cdpSnapshot(cdp: CDPSession) {
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value])) as Record<string, number>;
}

function cdpDelta(before: Record<string, number>, after: Record<string, number>) {
  const delta = (name: string) =>
    typeof before[name] === "number" && typeof after[name] === "number"
      ? after[name] - before[name]
      : null;
  return {
    taskDurationMs: delta("TaskDuration") === null ? null : delta("TaskDuration")! * 1_000,
    scriptDurationMs: delta("ScriptDuration") === null ? null : delta("ScriptDuration")! * 1_000,
    layoutDurationMs: delta("LayoutDuration") === null ? null : delta("LayoutDuration")! * 1_000,
    styleDurationMs: delta("RecalcStyleDuration") === null ? null : delta("RecalcStyleDuration")! * 1_000,
    domNodeDelta: delta("Nodes"),
    jsHeapDeltaBytes: delta("JSHeapUsedSize"),
  };
}

async function settleClientRender(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  ));
}

async function ready(page: Page, route: PerformanceRoute) {
  const title = route[0].toUpperCase() + route.slice(1);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await settleClientRender(page);
}

function visiblePanel(page: Page) {
  return page.locator('[data-slot="sheet-content"]:visible');
}

function browserProvenance(page: Page) {
  const browser = page.context().browser();
  if (!browser) throw new Error("Performance artifact requires a launched browser");
  return {
    browserEngine: browser.browserType().name(),
    browserVersion: browser.version(),
  };
}

async function waitForPanelShell(page: Page, category: string) {
  const sheet = visiblePanel(page);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: category, exact: true })).toBeVisible();
  return sheet;
}

async function waitForPanelEntity(sheet: ReturnType<typeof visiblePanel>, entityTitle: string) {
  // Editable panel titles render as buttons until editing begins, not headings.
  await expect(sheet.getByRole("button", { name: entityTitle, exact: true })).toBeVisible();
  await settleClientRender(sheet.page());
}

async function recordWarmNavigation(page: Page, cdp: CDPSession, collector: Awaited<ReturnType<typeof createResourceCollector>>, base: string, route: PerformanceRoute) {
  const requestId = `perf_${randomUUID()}`;
  await page.setExtraHTTPHeaders({
    "x-compass-perf-request-id": requestId,
    "x-compass-perf-build-sha": process.env.PERF_BUILD_SHA!,
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
      : {}),
  });
  collector.beginSample(requestId, { kind: "rsc", targetPath: `${base}/${route}`, match: "exact" });
  const startedAt = new Date().toISOString();
  const before = await cdpSnapshot(cdp);
  const prefetchObserved = await page.evaluate((targetPath) =>
    performance.getEntriesByType("resource").some((entry) => entry.name.includes(targetPath)),
    `${base}/${route}`
  );
  const start = performance.now();
  const responseObserver = createCompletedRscResponseObserver(`${base}/${route}`);
  page.on("response", responseObserver.observe);
  await page.locator(`a[href="${base}/${route}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/${route}(?:\\?|$)`));
  await ready(page, route);
  const semanticEnd = performance.now();
  page.off("response", responseObserver.observe);
  const after = await cdpSnapshot(cdp);
  const client = await readClientMetrics(page, false);
  const matchedRsc = await responseObserver.settle();
  const resourceSnapshot = await collector.closeSample(requestId, { warmRsc: true });
  const networkOutcome = resourceSnapshot.completedCount > 0
    ? "rsc-request"
    : resourceSnapshot.canceledCount > 0
      ? "router-cache-canceled-speculative"
      : "router-cache-hit";
  return {
    requestId,
    method: "GET",
    path: resourceSnapshot.resources[0]
      ? new URL(resourceSnapshot.resources[0].url).pathname + new URL(resourceSnapshot.resources[0].url).search
      : `${base}/${route}`,
    networkOutcome,
    prefetchObserved,
    startedAt,
    responseWaitMs: matchedRsc.completedAt === null ? null : matchedRsc.completedAt - start,
    durationMs: semanticEnd - start,
    resourceRequestCount: resourceSnapshot.attemptedCount,
    completedResourceRequestCount: resourceSnapshot.completedCount,
    canceledResourceRequestCount: resourceSnapshot.canceledCount,
    resources: resourceSnapshot.resources,
    requests: correlatedRequests(resourceSnapshot.resources),
    client,
    cdp: cdpDelta(before, after),
  };
}

test("records cold and warm workspace navigation", async ({ browser, page, workspaceBase }, testInfo) => {
  test.setTimeout(NAVIGATION_MATRIX.timeoutMs);
  await installClientObservers(page);
  const cdp = await page.context().newCDPSession(page);
  const resources: ResourceMetric[] = [];
  const collector = await createResourceCollector(cdp, resources);
  await page.goto(`${workspaceBase}/discovery`);
  await ready(page, "discovery");

  const warm = [];
  for (let warmup = 0; warmup < NAVIGATION_MATRIX.discardedWarmups; warmup++) {
    await recordWarmNavigation(page, cdp, collector, workspaceBase, ROUTES[(warmup + 1) % ROUTES.length]);
  }
  for (let iteration = 0; iteration < NAVIGATION_MATRIX.retainedWarmPerRoute; iteration++) {
    for (const route of ROUTES) warm.push({ route, ...(await recordWarmNavigation(page, cdp, collector, workspaceBase, route)) });
  }

  const cold = [];
  for (const route of ROUTES) {
    for (let iteration = 0; iteration < NAVIGATION_MATRIX.coldPerRoute; iteration++) {
      const requestId = `perf_${randomUUID()}`;
      const context = await browser.newContext({
        storageState: process.env.PERF_STORAGE_STATE,
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: {
          "x-compass-perf-request-id": requestId,
          "x-compass-perf-build-sha": process.env.PERF_BUILD_SHA!,
          ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
            : {}),
        },
      });
      const coldPage = await context.newPage();
      await installClientObservers(coldPage);
      const coldResources: ResourceMetric[] = [];
      const coldCdp = await context.newCDPSession(coldPage);
      const coldCollector = await createResourceCollector(coldCdp, coldResources);
      coldCollector.beginSample(requestId, { kind: "document", targetPath: `${workspaceBase}/${route}`, match: "exact" });
      const startedAt = new Date().toISOString();
      const before = await cdpSnapshot(coldCdp);
      const start = performance.now();
      const documentResponse = await coldPage.goto(`${workspaceBase}/${route}`);
      if (!documentResponse) throw new Error("Cold document navigation returned no response");
      await ready(coldPage, route);
      const semanticEnd = performance.now();
      const after = await cdpSnapshot(coldCdp);
      const client = await readClientMetrics(coldPage);
      const resourceSnapshot = await coldCollector.closeSample(requestId, { exact: 1 });
      cold.push({
        route,
        requestId,
        method: "GET",
        path: new URL(documentResponse.url()).pathname + new URL(documentResponse.url()).search,
        startedAt,
        durationMs: semanticEnd - start,
        resourceRequestCount: resourceSnapshot.attemptedCount,
        completedResourceRequestCount: resourceSnapshot.completedCount,
        canceledResourceRequestCount: resourceSnapshot.canceledCount,
        resources: resourceSnapshot.resources,
        requests: correlatedRequests(resourceSnapshot.resources),
        documentResource: resourceSnapshot.resources[0] ?? null,
        rscResources: [],
        client,
        cdp: cdpDelta(before, after),
      });
      await context.close();
    }
  }
  const artifact = {
    version: 2,
    recordedAt: new Date().toISOString(),
    buildSha: process.env.PERF_BUILD_SHA ?? null,
    deploymentId: process.env.PERF_DEPLOYMENT_ID ?? null,
    deploymentUrl: process.env.PERF_BASE_URL ?? null,
    projectId: process.env.PERF_PROJECT_ID ?? null,
    serverKind: process.env.PERF_SERVER_KIND,
    browser: testInfo.project.name,
    ...browserProvenance(page),
    viewport: { width: 1440, height: 900 },
    prefetchPolicy: "actual Next.js sidebar Link behavior; two warmups discarded",
    coldDefinition: "fresh browser context, cache-disabled direct document navigation; not a server cold start",
    metricBoundary: "duration, client, and CDP metrics end immediately after route readiness; resource completion settles afterward and is excluded",
    warm,
    cold,
    aggregates: {
      byRoute: { warm: groupedNavigationSummary(warm), cold: groupedNavigationSummary(cold) },
      overall: { warm: durationSummary(warm.map((sample) => sample.durationMs)), cold: durationSummary(cold.map((sample) => sample.durationMs)) },
    },
    resources,
    client: await readClientMetrics(page),
  };
  persistPerformanceArtifact(
    process.env.PERF_SERVER_KIND as "local-production" | "vercel-preview",
    "navigation",
    artifact
  );
  await testInfo.attach("performance-baseline", {
    body: Buffer.from(JSON.stringify(artifact, null, 2)),
    contentType: "application/json",
  });
});

for (const panel of [
  { route: "discovery", title: "Opportunity", apiType: "opportunity", artifactName: "panel-opportunity", entityEnv: "PERF_OPPORTUNITY_TITLE" },
  { route: "roadmap", title: "Roadmap Item", apiType: "roadmapItem", artifactName: "panel-roadmap-item", entityEnv: "PERF_ROADMAP_ITEM_TITLE" },
] as const) {
  test(`records ${panel.title} panel latency`, async ({ page, workspaceBase }, testInfo) => {
    await installClientObservers(page);
    const panelCdp = await page.context().newCDPSession(page);
    const panelResources: ResourceMetric[] = [];
    const panelCollector = await createResourceCollector(panelCdp, panelResources);
    await page.goto(`${workspaceBase}/${panel.route}`);
    await ready(page, panel.route);
    const entityTitle = process.env[panel.entityEnv];
    if (!entityTitle) throw new Error(`${panel.entityEnv} is required for deterministic panel targeting`);
    const samples = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      const requestId = `perf_${randomUUID()}`;
      await page.setExtraHTTPHeaders({
        "x-compass-perf-request-id": requestId,
        "x-compass-perf-build-sha": process.env.PERF_BUILD_SHA!,
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
          : {}),
      });
      panelCollector.beginSample(requestId, {
        kind: "api",
        targetPath: `/api/panels/entity/${panel.apiType}/`,
        match: "prefix",
      });
      const trigger = page.getByRole("button", { name: entityTitle, exact: true });
      await expect(trigger).toBeVisible();
      const responsePromise = page.waitForResponse((response) =>
        /^perf_[0-9a-f-]{36}$/.test(response.request().headers()["x-compass-perf-request-id"] ?? "") &&
        response.url().includes(`/api/panels/entity/${panel.apiType}/`) &&
        response.ok()
      );
      const startedAt = new Date().toISOString();
      const before = await cdpSnapshot(panelCdp);
      const start = performance.now();
      await trigger.click();
      const sheet = await waitForPanelShell(page, panel.title);
      const shellMs = performance.now() - start;
      const response = await responsePromise;
      const responseMs = performance.now() - start;
      await waitForPanelEntity(sheet, entityTitle);
      const semanticEnd = performance.now();
      const after = await cdpSnapshot(panelCdp);
      const client = await readClientMetrics(page, false);
      const resourceSnapshot = await panelCollector.closeSample(requestId, { exact: 1 });
      const meaningfulPaintMs = semanticEnd - start;
      const sample = {
        requestId,
        method: "GET",
        path: new URL(response.url()).pathname + new URL(response.url()).search,
        startedAt,
        shellMs,
        responseMs,
        meaningfulPaintMs,
        resourceRequestCount: resourceSnapshot.attemptedCount,
        completedResourceRequestCount: resourceSnapshot.completedCount,
        canceledResourceRequestCount: resourceSnapshot.canceledCount,
        status: response.status(),
        resources: resourceSnapshot.resources,
        requests: correlatedRequests(resourceSnapshot.resources),
        client,
        cdp: cdpDelta(before, after),
      };
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      if (iteration >= 2) samples.push(sample);
    }
    await readClientMetrics(page);
    const artifact = {
      version: 2,
      recordedAt: new Date().toISOString(),
      buildSha: process.env.PERF_BUILD_SHA ?? null,
      deploymentId: process.env.PERF_DEPLOYMENT_ID ?? null,
      deploymentUrl: process.env.PERF_BASE_URL ?? null,
      projectId: process.env.PERF_PROJECT_ID ?? null,
      serverKind: process.env.PERF_SERVER_KIND,
      browser: testInfo.project.name,
      ...browserProvenance(page),
      viewport: { width: 1440, height: 900 },
      panel: panel.apiType,
      warmupsDiscarded: 2,
      metricBoundary: "meaningful paint, client, and CDP metrics end immediately after the seeded entity title is visible; resource completion settles afterward and is excluded",
      samples,
      aggregates: {
        shell: durationSummary(samples.map((sample) => sample.shellMs)),
        response: durationSummary(samples.map((sample) => sample.responseMs)),
        meaningfulPaint: durationSummary(samples.map((sample) => sample.meaningfulPaintMs)),
      },
    };
    persistPerformanceArtifact(
      process.env.PERF_SERVER_KIND as "local-production" | "vercel-preview",
      panel.artifactName,
      artifact
    );
    await testInfo.attach(`${panel.apiType}-panel-baseline`, {
      body: Buffer.from(JSON.stringify(artifact, null, 2)),
      contentType: "application/json",
    });
  });
}
