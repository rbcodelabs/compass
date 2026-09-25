/**
 * app/api/analytics/measurements/route.ts — the GET read behind
 * MeasurementsPanel. It replaced the readMeasurements/listAnalyticsMetrics
 * server actions: reads dispatched as server actions go through the Next
 * router's action queue, and a navigation that preempts them can let a queued
 * read commit the pre-navigation URL (reopening a closed detail panel).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), listBindings: vi.fn(), observations: vi.fn(), listMetrics: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.workspace }));
vi.mock("@/lib/analytics/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analytics/service")>();
  return { targetSchema: actual.targetSchema, listBindings: mocks.listBindings, listObservations: mocks.observations, listMetrics: mocks.listMetrics };
});

import { GET } from "@/app/api/analytics/measurements/route";
import { AnalyticsError } from "@/lib/analytics/providers";

const target = "targetType=EXPERIMENT&targetId=00000000-0000-4000-8000-000000000001";
const request = (query: string) => new Request(`http://localhost/api/analytics/measurements?${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "human-user" } });
  mocks.workspace.mockResolvedValue({ id: "member-workspace" });
  mocks.listBindings.mockResolvedValue([]);
  mocks.listMetrics.mockResolvedValue([]);
});

describe("GET /api/analytics/measurements", () => {
  it("requires a session", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await GET(request(`orgSlug=org&workspaceSlug=ws&${target}`));
    expect(response.status).toBe(401);
    expect(mocks.listBindings).not.toHaveBeenCalled();
  });

  it("rejects a workspace outside session membership", async () => {
    mocks.workspace.mockResolvedValue(null);
    const response = await GET(request(`orgSlug=org&workspaceSlug=foreign&${target}`));
    expect(response.status).toBe(404);
    expect(mocks.workspace).toHaveBeenCalledWith("org", "foreign", "human-user");
    expect(mocks.listBindings).not.toHaveBeenCalled();
  });

  it("rejects a malformed target before calling services", async () => {
    const response = await GET(request("orgSlug=org&workspaceSlug=ws&targetType=TASK&targetId=nope"));
    expect(response.status).toBe(400);
    expect(mocks.listBindings).not.toHaveBeenCalled();
  });

  it("returns bindings with their observations and the metric catalogue, as the server-derived actor", async () => {
    const actor = { userId: "human-user", purpose: "USER" };
    mocks.listBindings.mockResolvedValue([{ id: "binding" }]);
    mocks.observations.mockResolvedValue([{ id: "observation" }]);
    mocks.listMetrics.mockResolvedValue([{ id: "metric" }]);
    const response = await GET(request(`orgSlug=org&workspaceSlug=ws&${target}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      measurements: [{ binding: { id: "binding" }, observations: [{ id: "observation" }] }],
      metrics: [{ id: "metric" }],
    });
    expect(mocks.listBindings).toHaveBeenCalledWith(actor, "member-workspace", { targetType: "EXPERIMENT", targetId: "00000000-0000-4000-8000-000000000001" });
    expect(mocks.observations).toHaveBeenCalledWith(actor, "member-workspace", "binding");
    expect(mocks.listMetrics).toHaveBeenCalledWith(actor, "member-workspace");
  });

  it("maps a service denial to 404 without leaking exception text", async () => {
    mocks.listBindings.mockRejectedValue(new AnalyticsError("NOT_FOUND_OR_ACCESS_DENIED"));
    const response = await GET(request(`orgSlug=org&workspaceSlug=ws&${target}`));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("maps an unexpected failure to a generic 500", async () => {
    mocks.listMetrics.mockRejectedValue(new Error("private detail"));
    const response = await GET(request(`orgSlug=org&workspaceSlug=ws&${target}`));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private detail");
  });
});
