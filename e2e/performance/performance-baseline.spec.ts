import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "@playwright/test";
import { ROUTES, expect, test, type PerformanceRoute } from "./fixtures";

type ResourceMetric = {
  sampleId: string | null;
  kind: "document" | "rsc" | "api";
  url: string;
  cdpEncodedDataLength: number;
  cdpDecodedDataLength: number;
};
type ClientMetric = {
  longTaskSupported: boolean;
  eventTimingSupported: boolean;
  heapSupported: boolean;
  longTaskCount: number | null;
  longTaskTotalMs: number | null;
  maxEventMs: number | null;
  heapBytes: number | null;
};
const durationSummary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { sampleCount: sorted.length, medianMs: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null };
};
const groupedNavigationSummary = (samples: Array<{ route: string; durationMs: number; networkOutcome?: string }>) =>
  Object.fromEntries([...new Set(samples.map((sample) => sample.route))].map((route) => [route, {
    overall: durationSummary(samples.filter((sample) => sample.route === route).map((sample) => sample.durationMs)),
    byNetworkOutcome: Object.fromEntries([...new Set(samples.filter((sample) => sample.route === route).map((sample) => sample.networkOutcome ?? "document"))].map((outcome) => [outcome, durationSummary(samples.filter((sample) => sample.route === route && (sample.networkOutcome ?? "document") === outcome).map((sample) => sample.durationMs))])),
  }]));

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

async function collectResources(cdp: CDPSession, resources: ResourceMetric[]) {
  const requests = new Map<string, { url: string; decodedBytes: number; sampleId: string | null; kind: "document" | "rsc" | "api" }>();
  const requestHeaders = new Map<string, Record<string, string>>();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    requestHeaders.set(requestId, request.headers as Record<string, string>);
  });
  cdp.on("Network.responseReceived", ({ requestId, response, type }) => {
    const headers = requestHeaders.get(requestId) ?? response.requestHeaders ?? {};
    const isRsc = headers.rsc === "1" || headers.RSC === "1" ||
      String(response.mimeType).includes("x-component");
    const isPanelApi = response.url.includes("/api/panels/entity/");
    if (isRsc || type === "Document" || isPanelApi) requests.set(requestId, {
      url: response.url,
      decodedBytes: 0,
      sampleId: String(headers["x-compass-perf-request-id"] ?? headers["X-Compass-Perf-Request-Id"] ?? "") || null,
      kind: isRsc ? "rsc" : isPanelApi ? "api" : "document",
    });
  });
  cdp.on("Network.dataReceived", ({ requestId, dataLength }) => {
    const request = requests.get(requestId);
    if (request) request.decodedBytes += dataLength;
  });
  cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
    const request = requests.get(requestId);
    if (request) resources.push({
      url: request.url,
      sampleId: request.sampleId,
      kind: request.kind,
      cdpDecodedDataLength: request.decodedBytes,
      cdpEncodedDataLength: encodedDataLength,
    });
  });
  await cdp.send("Network.enable");
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

async function recordWarmNavigation(page: Page, cdp: CDPSession, base: string, route: PerformanceRoute, resources: ResourceMetric[]) {
  const requestId = `perf_${randomUUID()}`;
  await page.setExtraHTTPHeaders({
    "x-compass-perf-request-id": requestId,
    ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
      : {}),
  });
  const startedAt = new Date().toISOString();
  const before = await cdpSnapshot(cdp);
  const prefetchObserved = await page.evaluate((targetPath) =>
    performance.getEntriesByType("resource").some((entry) => entry.name.includes(targetPath)),
    `${base}/${route}`
  );
  const start = performance.now();
  let matchedRscUrl: string | null = null;
  let matchedRscAt: number | null = null;
  const observeResponse = (candidate: import("@playwright/test").Response) => {
    const headers = candidate.request().headers();
    if (headers["x-compass-perf-request-id"] === requestId &&
      (headers.rsc === "1" || candidate.headers()["content-type"]?.includes("text/x-component"))) {
      matchedRscUrl = candidate.url();
      matchedRscAt = performance.now();
    }
  };
  page.on("response", observeResponse);
  await page.locator(`a[href="${base}/${route}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/${route}(?:\\?|$)`));
  await ready(page, route);
  page.off("response", observeResponse);
  if (matchedRscUrl) await expect.poll(() => resources.filter((resource) => resource.sampleId === requestId && resource.kind === "rsc").length).toBeGreaterThan(0);
  const after = await cdpSnapshot(cdp);
  return {
    requestId,
    method: "GET",
    path: matchedRscUrl ? new URL(matchedRscUrl).pathname + new URL(matchedRscUrl).search : `${base}/${route}`,
    networkOutcome: matchedRscUrl ? "rsc-request" : "router-cache-hit",
    prefetchObserved,
    startedAt,
    responseWaitMs: matchedRscAt === null ? null : matchedRscAt - start,
    durationMs: performance.now() - start,
    resources: resources.filter((resource) => resource.sampleId === requestId),
    client: await readClientMetrics(page, false),
    cdp: cdpDelta(before, after),
  };
}

test("records cold and warm workspace navigation", async ({ browser, page, workspaceBase }, testInfo) => {
  await installClientObservers(page);
  const cdp = await page.context().newCDPSession(page);
  const resources: ResourceMetric[] = [];
  await collectResources(cdp, resources);
  await page.goto(`${workspaceBase}/discovery`);
  await ready(page, "discovery");

  const warm = [];
  for (let warmup = 0; warmup < 2; warmup++) {
    await recordWarmNavigation(page, cdp, workspaceBase, ROUTES[(warmup + 1) % ROUTES.length], resources);
  }
  for (let iteration = 0; iteration < 10; iteration++) {
    for (const route of ROUTES) warm.push({ route, ...(await recordWarmNavigation(page, cdp, workspaceBase, route, resources)) });
  }

  const cold = [];
  for (const route of ROUTES) {
    for (let iteration = 0; iteration < 5; iteration++) {
      const requestId = `perf_${randomUUID()}`;
      const context = await browser.newContext({
        storageState: process.env.PERF_STORAGE_STATE,
        viewport: { width: 1440, height: 900 },
        extraHTTPHeaders: {
          "x-compass-perf-request-id": requestId,
          ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
            ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
            : {}),
        },
      });
      const coldPage = await context.newPage();
      await installClientObservers(coldPage);
      const coldResources: ResourceMetric[] = [];
      const coldCdp = await context.newCDPSession(coldPage);
      await collectResources(coldCdp, coldResources);
      const startedAt = new Date().toISOString();
      const before = await cdpSnapshot(coldCdp);
      const start = performance.now();
      const documentResponse = await coldPage.goto(`${workspaceBase}/${route}`);
      if (!documentResponse) throw new Error("Cold document navigation returned no response");
      await ready(coldPage, route);
      await expect.poll(() => coldResources.filter((resource) => resource.kind === "document" && resource.sampleId === requestId).length).toBe(1);
      const after = await cdpSnapshot(coldCdp);
      cold.push({
        route,
        requestId,
        method: "GET",
        path: new URL(documentResponse.url()).pathname + new URL(documentResponse.url()).search,
        startedAt,
        durationMs: performance.now() - start,
        resources: coldResources,
        documentResource: coldResources.find((resource) => resource.kind === "document") ?? null,
        rscResources: coldResources.filter((resource) => resource.kind === "rsc"),
        client: await readClientMetrics(coldPage),
        cdp: cdpDelta(before, after),
      });
      await context.close();
    }
  }
  const artifact = {
    version: 1,
    recordedAt: new Date().toISOString(),
    buildSha: process.env.PERF_BUILD_SHA ?? null,
    serverKind: process.env.PERF_SERVER_KIND,
    browser: testInfo.project.name,
    viewport: { width: 1440, height: 900 },
    prefetchPolicy: "actual Next.js sidebar Link behavior; two warmups discarded",
    coldDefinition: "fresh browser context, cache-disabled direct document navigation; not a server cold start",
    warm,
    cold,
    aggregates: {
      byRoute: { warm: groupedNavigationSummary(warm), cold: groupedNavigationSummary(cold) },
      overall: { warm: durationSummary(warm.map((sample) => sample.durationMs)), cold: durationSummary(cold.map((sample) => sample.durationMs)) },
    },
    resources,
    client: await readClientMetrics(page),
  };
  const path = testInfo.outputPath("performance-baseline.json");
  await testInfo.attach("performance-baseline", {
    body: Buffer.from(JSON.stringify(artifact, null, 2)),
    contentType: "application/json",
  });
  expect(path).toBeTruthy();
});

for (const panel of [
  { route: "discovery", title: "Opportunity", apiType: "opportunity", entityEnv: "PERF_OPPORTUNITY_TITLE" },
  { route: "roadmap", title: "Roadmap Item", apiType: "roadmapItem", entityEnv: "PERF_ROADMAP_ITEM_TITLE" },
] as const) {
  test(`records ${panel.title} panel latency`, async ({ page, workspaceBase }, testInfo) => {
    await installClientObservers(page);
    const panelCdp = await page.context().newCDPSession(page);
    const panelResources: ResourceMetric[] = [];
    await collectResources(panelCdp, panelResources);
    await page.goto(`${workspaceBase}/${panel.route}`);
    await ready(page, panel.route);
    const entityTitle = process.env[panel.entityEnv];
    if (!entityTitle) throw new Error(`${panel.entityEnv} is required for deterministic panel targeting`);
    const samples = [];
    for (let iteration = 0; iteration < 12; iteration++) {
      const requestId = `perf_${randomUUID()}`;
      await page.setExtraHTTPHeaders({
        "x-compass-perf-request-id": requestId,
        ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
          ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET }
          : {}),
      });
      const trigger = page.getByRole("button", { name: entityTitle, exact: true });
      await expect(trigger).toBeVisible();
      const responsePromise = page.waitForResponse((response) =>
        response.request().headers()["x-compass-perf-request-id"] === requestId &&
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
      await expect.poll(() => panelResources.filter((resource) => resource.sampleId === requestId).length).toBeGreaterThan(0);
      const meaningfulPaintMs = performance.now() - start;
      const after = await cdpSnapshot(panelCdp);
      const sample = {
        requestId,
        method: "GET",
        path: new URL(response.url()).pathname + new URL(response.url()).search,
        startedAt,
        shellMs,
        responseMs,
        meaningfulPaintMs,
        status: response.status(),
        resources: panelResources.filter((resource) => resource.sampleId === requestId),
        client: await readClientMetrics(page, false),
        cdp: cdpDelta(before, after),
      };
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
      if (iteration >= 2) samples.push(sample);
    }
    await readClientMetrics(page);
    await testInfo.attach(`${panel.apiType}-panel-baseline`, {
      body: Buffer.from(JSON.stringify({
        version: 1,
        recordedAt: new Date().toISOString(),
        panel: panel.apiType,
        warmupsDiscarded: 2,
        samples,
        aggregates: {
          shell: durationSummary(samples.map((sample) => sample.shellMs)),
          response: durationSummary(samples.map((sample) => sample.responseMs)),
          meaningfulPaint: durationSummary(samples.map((sample) => sample.meaningfulPaintMs)),
        },
      }, null, 2)),
      contentType: "application/json",
    });
  });
}
