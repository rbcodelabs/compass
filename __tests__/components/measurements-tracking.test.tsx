// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
const mocks = vi.hoisted(() => ({ read: vi.fn(), metrics: vi.fn(), link: vi.fn(), update: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/analytics/measurement-reads", () => ({ readMeasurements: mocks.read, listAnalyticsMetrics: mocks.metrics }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions", () => ({ linkAnalyticsMetric: mocks.link, updateAnalyticsMeasurement: mocks.update, refreshAnalyticsMeasurement: mocks.refresh }));
import { MeasurementsPanel } from "@/components/analytics/measurements-panel";
const metric = { id: "metric", name: "Overall Daily Visitors", unit: "visitors", provider: "vercel", revision: 1, archived: false, query: { metric: "daily_visitors" } };
const tracking = { id: "binding", metricId: metric.id, mode: "tracking", baseline: null, followup: { version: 1, mode: "rolling", days: 30 }, metric };
function panel() { return render(<MeasurementsPanel orgSlug="example" workspaceSlug="product" target={{ targetId: "target", targetType: "KEY_RESULT" }} />); }
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue([]); mocks.metrics.mockResolvedValue([metric]); });
afterEach(cleanup);
describe("optional-baseline measurements", () => {
  it("does not offer seven or ninety days for native activation snapshots", async () => {
    mocks.metrics.mockResolvedValue([{ ...metric, provider: "compass_activation", name: "Active Discovery Teams", query: { metric: "active_discovery_teams" } }]);
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Link metric" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Link metric" }));
    expect(screen.queryByRole("option", { name: "Last 7 days" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Last 90 days" })).not.toBeInTheDocument();
  });
  it("defaults to tracking and links without entering dates", async () => {
    mocks.link.mockResolvedValue({ ok: true, data: tracking });
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Link metric" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Link metric" }));
    expect(screen.getByRole("radio", { name: /Track over time/ })).toBeChecked();
    expect(screen.queryByLabelText("Baseline from")).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await waitFor(() => expect(mocks.link).toHaveBeenCalledWith("example", "product", { targetId: "target", targetType: "KEY_RESULT", metricId: "metric", baseline: null, followup: { version: 1, mode: "rolling", days: 30 } }));
  });
  it("explains missing comparison dates inline without calling the server", async () => {
    panel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Link metric" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Link metric" }));
    fireEvent.click(screen.getByRole("radio", { name: /Compare periods/ }));
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    expect(await screen.findByText("Choose both baseline dates.")).toBeInTheDocument();
    expect(screen.getByText("Choose both follow-up dates.")).toBeInTheDocument();
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("shows latest daily visitors and gaps without inventing a monthly total", async () => {
    mocks.read.mockResolvedValue([{ binding: tracking, observations: [{ id: "observation", windowKind: "FOLLOWUP", retrievedAt: "2026-09-24T12:00:00Z", snapshot: { window: { since: "2026-09-21", until: "2026-09-23" } }, data: { value: null, completeness: "PARTIAL", note: "Missing daily buckets", series: [{ date: "2026-09-21", value: 21 }, { date: "2026-09-23", value: 42 }] } }] }]);
    panel();
    expect(await screen.findByText(/Latest available day/)).toBeInTheDocument();
    expect(screen.getByText("Partial coverage")).toBeInTheDocument();
    expect(screen.queryByText("63")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Daily trend/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compare periods" })).toBeInTheDocument();
  });
  it("converts tracking through immutable replacement rather than linking a second metric", async () => {
    mocks.read.mockResolvedValue([{ binding: tracking, observations: [] }]);
    const windows = { baseline: { since: "2026-09-01", until: "2026-09-07" }, followup: { since: "2026-09-08", until: "2026-09-14" } };
    mocks.update.mockResolvedValue({ ok: true, data: { ...tracking, ...windows, mode: "comparison", id: "replacement" } });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Compare periods" }));
    for (const [label, value] of [["Baseline from", windows.baseline.since], ["Baseline through", windows.baseline.until], ["Follow-up from", windows.followup.since], ["Follow-up through", windows.followup.until]]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save comparison" }));
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith("example", "product", "binding", windows));
    expect(mocks.link).not.toHaveBeenCalled();
    expect(await screen.findByText("Comparison")).toBeInTheDocument();
    expect(screen.getAllByTestId("metric-measurement")).toHaveLength(1);
  });
  it("shows serialized refresh failure guidance while retaining the measurement", async () => {
    mocks.read.mockResolvedValue([{ binding: tracking, observations: [] }]);
    mocks.refresh.mockResolvedValue({ ok: false, error: "DISCONNECTED" });
    panel();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reconnect the metric's provider before refreshing. Existing evidence has been preserved.");
    expect(screen.getByText(metric.name)).toBeInTheDocument();
  });
});
