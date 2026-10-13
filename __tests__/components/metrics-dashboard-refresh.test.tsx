// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const actions = vi.hoisted(() => ({
  archive: vi.fn(),
  create: vi.fn(),
  edit: vi.fn(),
  refresh: vi.fn(),
  row: vi.fn(),
}))
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/analytics-actions", () => ({
  archiveAnalyticsMetric: actions.archive,
  createAnalyticsMetric: actions.create,
  editAnalyticsMetric: actions.edit,
  refreshAnalyticsMeasurement: actions.refresh,
  getDashboardMetricRow: actions.row,
}))
// The dashboard also imports the layout actions at module scope. They are unrelated
// to refreshing, so they are stubbed only so the import resolves outside a request.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/metrics/actions", () => ({
  resizeDashboardMetric: vi.fn(),
  setDashboardMetricVisible: vi.fn(),
  reorderDashboardMetric: vi.fn(),
}))

import { MetricsDashboard } from "@/components/analytics/metrics-dashboard"
import type { DashboardMetricDTO, MetricDTO } from "@/lib/analytics/service"

const metric: MetricDTO = {
  id: "metric-signups",
  workspaceId: "ws-1",
  revisionId: "rev-1",
  revision: 1,
  name: "Signups",
  unit: "signups",
  provider: "vercel",
  connectionId: "conn-vercel",
  query: { metric: "pageviews" },
  archived: false,
}

function dashboardRow(source: MetricDTO): DashboardMetricDTO {
  return {
    id: source.id,
    dashboardVisible: true,
    dashboardCol: 0,
    dashboardRow: 0,
    dashboardSortOrder: 0,
    metric: source,
    status: "fresh",
    statusCaption: "Not yet linked to a metric binding",
    value: null,
    delta: null,
    sparkline: [],
    bindings: [],
    refreshBindingId: null,
  }
}

const linked: DashboardMetricDTO = {
  ...dashboardRow(metric),
  status: "stale",
  statusCaption: "Last synced 3 days ago",
  value: 10,
  refreshBindingId: "binding-1",
}
const fresh: DashboardMetricDTO = { ...linked, status: "fresh", statusCaption: "Synced just now", value: 42 }

function renderDashboard(rows: DashboardMetricDTO[] = [linked]) {
  render(
    <MetricsDashboard orgSlug="acme" workspaceSlug="product" initialMetrics={rows} vercelConnectionId="conn-vercel" />,
  )
}
const refreshButton = () => screen.getByRole("button", { name: "Refresh Signups" }) as HTMLButtonElement

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe("MetricsDashboard — refreshing from the card", () => {
  it("refreshes the card's binding, then re-reads the card so the new value shows", async () => {
    actions.refresh.mockResolvedValue({ ok: true, data: {} })
    actions.row.mockResolvedValue({ ok: true, data: fresh })
    renderDashboard()
    expect(screen.getByText("Last synced 3 days ago")).toBeTruthy()

    fireEvent.click(refreshButton())

    expect(await screen.findByText("Synced just now")).toBeTruthy()
    expect(screen.getByText("42")).toBeTruthy()
    expect(actions.refresh).toHaveBeenCalledWith("acme", "product", "binding-1", expect.any(String))
    expect(actions.row).toHaveBeenCalledWith("acme", "product", metric.id)
  })

  it("disables refresh on a metric with no binding, since there is nothing to capture into", () => {
    renderDashboard([dashboardRow(metric)])
    expect(refreshButton().disabled).toBe(true)
    expect((screen.getByRole("button", { name: /Refresh all/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(refreshButton())
    expect(actions.refresh).not.toHaveBeenCalled()
  })

  it("names the failing metric, and still re-reads so the card shows the recorded error", async () => {
    actions.refresh.mockResolvedValue({ ok: false, error: "RATE_LIMITED" })
    actions.row.mockResolvedValue({ ok: true, data: { ...linked, status: "failed", statusCaption: "Last refresh failed" } })
    renderDashboard()

    fireEvent.click(refreshButton())

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toContain("Signups")
    expect(alert.textContent).toMatch(/rate-limited/)
    expect(await screen.findByText("Last refresh failed")).toBeTruthy()
    expect(actions.row).toHaveBeenCalledTimes(1)
  })

  it("does not roll back a resize made while the provider was working", async () => {
    let finish: (value: unknown) => void = () => {}
    actions.refresh.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    actions.row.mockResolvedValue({ ok: true, data: { ...fresh, dashboardCol: 0, dashboardRow: 0 } })
    renderDashboard([{ ...linked, dashboardCol: 2, dashboardRow: 3 }])
    const card = screen.getByTestId("metric-card")

    fireEvent.click(refreshButton())
    expect(refreshButton().disabled).toBe(true)
    finish({ ok: true, data: {} })

    await screen.findByText("Synced just now")
    expect(card.style.gridColumn).toBe("span 2")
    expect(card.style.gridRow).toBe("span 3")
  })

  it("Refresh all refreshes each linked metric once, in order, and skips unlinked ones", async () => {
    const other: DashboardMetricDTO = { ...linked, id: "metric-2", metric: { ...metric, id: "metric-2", name: "Other" }, refreshBindingId: "binding-2" }
    const unlinked = dashboardRow({ ...metric, id: "metric-3", name: "Unlinked" })
    actions.refresh.mockResolvedValue({ ok: true, data: {} })
    actions.row.mockImplementation(async (_org: string, _ws: string, id: string) => ({
      ok: true,
      data: id === "metric-2" ? { ...other, value: 7 } : fresh,
    }))
    renderDashboard([linked, other, unlinked])

    fireEvent.click(screen.getByRole("button", { name: /Refresh all/ }))

    await waitFor(() => expect(actions.refresh).toHaveBeenCalledTimes(2))
    expect(actions.refresh.mock.calls.map((call) => call[2])).toEqual(["binding-1", "binding-2"])
    expect(actions.row).toHaveBeenCalledTimes(2)
  })
})
