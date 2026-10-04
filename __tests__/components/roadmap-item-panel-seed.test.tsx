// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    openPanel: vi.fn(),
    notifyEntityMutated: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/following/follow-button", () => ({ FollowButton: () => null }));
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }));
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => null }));
vi.mock("@/components/panels/launch-checklist", () => ({ LaunchChecklist: () => null }));
vi.mock("@/components/panels/launch-tier-picker", () => ({ LaunchTierPicker: () => null }));
vi.mock("@/components/panels/positioning-brief-row", () => ({ PositioningBriefRow: () => null }));
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => null }));
vi.mock("@/components/analytics/measurements-panel", () => ({ MeasurementsPanel: () => null }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({ archiveItem: vi.fn() }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({ upsertFieldValue: vi.fn() }));

import { RoadmapItemPanel } from "@/components/panels/roadmap-item-panel";
import { setPanelSeed, peekPanelSeed, clearPanelSeed } from "@/lib/panel-seed";

const full = (id: string, title: string) => ({
  id, workspaceId: "ws-1", title, description: `${title} full description`,
  horizon: "NOW", status: "ACTIVE", isPrivate: false, startDate: null, endDate: null,
  updatedAt: "2026-09-07T00:00:00.000Z", squad: null, solution: null, keyResult: null,
  opportunity: null, experiment: null, feedback: null, launchChecklist: null,
  positioningBrief: null, launchWorkflowEnabled: true, deliveryTasks: [], linkableTasks: [],
  members: [], customFields: [], _count: { votes: 0 },
});

const seedFor = (id: string, title: string) => ({
  id, title, description: "Seeded description", horizon: "NEXT",
  squad: { id: "sq", name: "Growth squad", color: "#fff" },
});

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** fetch stub whose responses the test resolves by hand, keyed by entity id. */
function controllableFetch() {
  const pending = new Map<string, Deferred>();
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const id = /roadmapItem\/([^?]+)/.exec(url)![1];
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (data) => resolve({ ok: true, json: () => Promise.resolve({ type: "roadmapItem", data }) }),
        reject,
      });
    });
  }));
  return pending;
}

const props = { orgSlug: "acme", workspaceSlug: "product" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const id of ["ri-1", "ri-2"]) clearPanelSeed("roadmapItem", id);
});

describe("RoadmapItemPanel seeded paint", () => {
  it("shows a skeleton and no title when there is no seed and the fetch is pending", () => {
    controllableFetch();
    render(<RoadmapItemPanel id="ri-1" {...props} />);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("paints the seeded title, horizon badge, description and squad while the fetch is pending", () => {
    controllableFetch();
    setPanelSeed("roadmapItem", "ri-1", seedFor("ri-1", "Seeded title"));
    render(<RoadmapItemPanel id="ri-1" {...props} />);

    expect(screen.getByRole("heading", { name: "Seeded title" })).toBeInTheDocument();
    expect(screen.getByText("Next")).toBeInTheDocument();
    expect(screen.getByText("Seeded description")).toBeInTheDocument();
    expect(screen.getByText("Growth squad")).toBeInTheDocument();
  });

  it("keeps the seeded header read-only (no textbox, no horizon select, no buttons)", () => {
    controllableFetch();
    setPanelSeed("roadmapItem", "ri-1", seedFor("ri-1", "Seeded title"));
    render(<RoadmapItemPanel id="ri-1" {...props} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Next|Seeded title/ })).toBeNull();
  });

  it("replaces the seed with the fetched payload and clears the seed once loaded", async () => {
    const pending = controllableFetch();
    setPanelSeed("roadmapItem", "ri-1", seedFor("ri-1", "Seeded title"));
    render(<RoadmapItemPanel id="ri-1" {...props} />);
    await waitFor(() => expect(pending.has("ri-1")).toBe(true));

    await act(async () => pending.get("ri-1")!.resolve(full("ri-1", "Fetched title")));

    expect(await screen.findByText("Fetched title")).toBeInTheDocument();
    expect(screen.queryByText("Seeded title")).toBeNull();
    expect(peekPanelSeed("roadmapItem", "ri-1")).toBeUndefined();
  });

  it("does not show item A's seed when item B is opened", () => {
    controllableFetch();
    setPanelSeed("roadmapItem", "ri-1", seedFor("ri-1", "Item A seed"));
    render(<RoadmapItemPanel id="ri-2" {...props} />);
    expect(screen.queryByText("Item A seed")).toBeNull();
  });


  it("clears the seed when the fetch errors (otherwise it lingers and re-paints stale data on a later open)", async () => {
    const pending = controllableFetch();
    setPanelSeed("roadmapItem", "ri-1", seedFor("ri-1", "Seeded title"));
    render(<RoadmapItemPanel id="ri-1" {...props} />);
    await waitFor(() => expect(pending.has("ri-1")).toBe(true));
    await act(async () => pending.get("ri-1")!.reject(new Error("boom")));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Seeded title" })).toBeNull());
    expect(peekPanelSeed("roadmapItem", "ri-1")).toBeUndefined();
  });

  it("does not paint a stale seed left behind by an early close", () => {
    controllableFetch();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      setPanelSeed("roadmapItem", "ri-1", seedFor("ri-1", "Seeded title"));
      const { unmount } = render(<RoadmapItemPanel id="ri-1" {...props} />);
      unmount();
      vi.setSystemTime(Date.now() + 60_000);
      render(<RoadmapItemPanel id="ri-1" {...props} />);
      expect(screen.queryByRole("heading", { name: "Seeded title" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("switching from loaded item A to card-seeded item B still paints B's seed", async () => {
    // PanelShell renders <RoadmapItemPanel id=...> with no key, so the instance
    // survives an id change. The first render for B still holds A's `data`, which
    // takes the "loaded" branch and runs clearPanelSeed("roadmapItem", "ri-2")
    // before B's seed was ever read.
    const pending = controllableFetch();
    const { rerender } = render(<RoadmapItemPanel key="ri-1" id="ri-1" {...props} />);
    await waitFor(() => expect(pending.has("ri-1")).toBe(true));
    await act(async () => pending.get("ri-1")!.resolve(full("ri-1", "Loaded A")));
    await screen.findByText("Loaded A");

    setPanelSeed("roadmapItem", "ri-2", seedFor("ri-2", "Seeded B"));
    rerender(<RoadmapItemPanel key="ri-2" id="ri-2" {...props} />);

    expect(await screen.findByRole("heading", { name: "Seeded B" })).toBeInTheDocument();
  });
});
