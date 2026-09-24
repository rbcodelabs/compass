import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), workspace: vi.fn(), create: vi.fn(), connect: vi.fn(), listBindings: vi.fn(), observations: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/workspace", () => ({ getWorkspace: mocks.workspace }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/analytics/service", () => ({ createMetric: mocks.create, saveVercelConnection: mocks.connect, listBindings: mocks.listBindings, listObservations: mocks.observations }));
import { createAnalyticsMetric, connectAnalytics, readMeasurements, disconnectAnalytics, editAnalyticsMetric, archiveAnalyticsMetric, linkAnalyticsMetric, unlinkAnalyticsMetric, refreshAnalyticsMeasurement, listAnalyticsMetrics, updateAnalyticsMeasurement } from "@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions";
import { AnalyticsError } from "@/lib/analytics/providers";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "human-user" } });
  mocks.workspace.mockResolvedValue({ id: "member-workspace" });
});

describe("analytics server action identity", () => {
  it("serializes expected provider failures so Next production redaction cannot erase them", async () => {
    mocks.connect.mockRejectedValue(new AnalyticsError("ANALYTICS_DISABLED"));
    await expect(connectAnalytics("org", "workspace", { projectId: "project", token: "private" })).resolves.toEqual({ ok: false, error: "ANALYTICS_DISABLED" });
  });
  it("never serializes an unknown exception or unrecognized error code", async () => {
    for (const error of [new Error("private token"), new AnalyticsError("private token")]) {
      mocks.connect.mockRejectedValue(error);
      await expect(connectAnalytics("org", "workspace", { projectId: "project", token: "private" })).resolves.toEqual({ ok: false, error: "CHANGE_FAILED" });
    }
  });
  it.each([
    () => disconnectAnalytics("org", "workspace", "connection"),
    () => editAnalyticsMetric("org", "workspace", "metric", {} as never),
    () => archiveAnalyticsMetric("org", "workspace", "metric"),
    () => linkAnalyticsMetric("org", "workspace", {} as never),
    () => updateAnalyticsMeasurement("org", "workspace", "binding", {} as never),
    () => unlinkAnalyticsMetric("org", "workspace", "binding"),
    () => refreshAnalyticsMeasurement("org", "workspace", "binding", "request"),
    () => listAnalyticsMetrics("org", "workspace"),
  ])("requires a session for each adapter action", async call => {
    mocks.auth.mockResolvedValue(null);
    await expect(call()).rejects.toThrow("Unauthorized");
  });
  it("rejects unauthenticated mutation before calling services", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(createAnalyticsMetric("org", "workspace", {} as never)).rejects.toThrow("Unauthorized");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("rejects a workspace outside session membership", async () => {
    mocks.workspace.mockResolvedValue(null);
    await expect(connectAnalytics("org", "foreign", { projectId: "project", token: "private" })).rejects.toThrow("Workspace not found");
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("derives actor and workspace on the server instead of trusting client fields", async () => {
    const input = { name: "Views", unit: "views", provider: "vercel" as const, query: { metric: "pageviews" as const } };
    await createAnalyticsMetric("org", "workspace", input);
    expect(mocks.workspace).toHaveBeenCalledWith("org", "workspace", "human-user");
    expect(mocks.create).toHaveBeenCalledWith({ userId: "human-user", purpose: "USER" }, "member-workspace", input);
  });
  it("reads observations only for service-authorized bindings", async () => {
    mocks.listBindings.mockResolvedValue([{ id: "binding" }]);
    mocks.observations.mockResolvedValue([]);
    await readMeasurements("org", "workspace", { targetType: "EXPERIMENT", targetId: "experiment" });
    expect(mocks.observations).toHaveBeenCalledWith({ userId: "human-user", purpose: "USER" }, "member-workspace", "binding");
  });
});
