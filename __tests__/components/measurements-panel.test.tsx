// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { BindingDTO, MetricDTO, ObservationDTO } from "@/lib/analytics/service";

const actions = vi.hoisted(() => ({
  link: vi.fn(),
  listMetrics: vi.fn(),
  read: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions", () => ({
  linkAnalyticsMetric: actions.link,
  refreshAnalyticsMeasurement: actions.refresh,
}));
// Reads go through GET /api/analytics/measurements, never a server action.
vi.mock("@/lib/analytics/measurements-client", () => ({
  loadMeasurements: async () => ({ measurements: await actions.read(), metrics: await actions.listMetrics() }),
}));

import { MeasurementsPanel } from "@/components/analytics/measurements-panel";

const metric: MetricDTO = {
  id: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  revisionId: "00000000-0000-4000-8000-000000000003",
  revision: 1,
  name: "Daily visitors",
  unit: "visitors",
  provider: "vercel",
  connectionId: "00000000-0000-4000-8000-000000000004",
  query: { metric: "daily_visitors" },
  archived: false,
};

const binding = {
  mode: "comparison",
  id: "00000000-0000-4000-8000-000000000005",
  workspaceId: metric.workspaceId,
  metricId: metric.id,
  revisionId: metric.revisionId,
  targetType: "EXPERIMENT",
  targetId: "00000000-0000-4000-8000-000000000006",
  targetValue: null,
  active: true,
  lastError: null,
  lastAttemptAt: null,
  lastAttemptId: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
  baseline: { since: "2026-09-01", until: "2026-09-02" },
  followup: { since: "2026-09-03", until: "2026-09-04" },
  metric,
} as Extract<BindingDTO, { mode: "comparison" }>;

function observation(kind: "BASELINE" | "FOLLOWUP", window: { since: string; until: string }, values: number[]): ObservationDTO {
  return {
    id: `${kind}-observation`,
    workspaceId: metric.workspaceId,
    bindingId: binding.id,
    revisionId: metric.revisionId,
    refreshKey: `${kind}-key`,
    windowKind: kind,
    snapshot: { window },
    data: {
      value: null,
      series: values.map((value, index) => ({ date: new Date(`${window.since}T00:00:00Z`).toISOString().slice(0, 8) + String(index + 1).padStart(2, "0"), value })),
      completeness: "COMPLETE",
      note: "Daily visitors cannot be summed into unique visitors for the period.",
      provenance: {},
    },
    retrievedAt: new Date("2026-09-20T10:42:00Z"),
  } as ObservationDTO;
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.listMetrics.mockResolvedValue([metric]);
});

afterEach(cleanup);

describe("MeasurementsPanel", () => {
  it("renders daily visitor points without inventing a period total", async () => {
    actions.read.mockResolvedValue([{ binding, observations: [
      observation("BASELINE", binding.baseline, [3, 5]),
      observation("FOLLOWUP", binding.followup, [4, 7]),
    ] }]);

    render(<MeasurementsPanel orgSlug="org" workspaceSlug="workspace" target={{ targetType: "EXPERIMENT", targetId: binding.targetId }} />);

    expect(await screen.findByText("3 visitors")).toBeInTheDocument();
    expect(screen.getByText("7 visitors")).toBeInTheDocument();
    expect(screen.queryByText("19 visitors")).not.toBeInTheDocument();
  });

  it("labels a rolling observation with its persisted effective window", async () => {
    const activationMetric = { ...metric, name: "Active Discovery Teams", provider: "compass_activation" as const, connectionId: null, query: { metric: "active_discovery_teams" as const } };
    const activationBinding = { ...binding, metric: activationMetric };
    const followup = { ...observation("FOLLOWUP", { since: "2026-08-22", until: "2026-09-20" }, [4]), data: { ...observation("FOLLOWUP", { since: "2026-08-22", until: "2026-09-20" }, [4]).data, value: 4 } };
    actions.listMetrics.mockResolvedValue([activationMetric]);
    actions.read.mockResolvedValue([{ binding: activationBinding, observations: [followup] }]);

    render(<MeasurementsPanel orgSlug="org" workspaceSlug="workspace" target={{ targetType: "EXPERIMENT", targetId: binding.targetId }} />);

    expect(await screen.findByText("Aug 22, 2026 – Sep 20, 2026 UTC")).toBeInTheDocument();
    expect(screen.getByText(/Rolling snapshot; requested Sep 3, 2026/)).toBeInTheDocument();
  });

  it("shows a real load error instead of an empty state", async () => {
    actions.read.mockRejectedValue(new Error("ACCESS_DENIED"));

    render(<MeasurementsPanel orgSlug="org" workspaceSlug="workspace" target={{ targetType: "EXPERIMENT", targetId: binding.targetId }} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Measurements could not be loaded");
    expect(screen.queryByText(/No metrics linked yet/)).not.toBeInTheDocument();
  });
});
