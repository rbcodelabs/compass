// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PANEL_SECTION_COOKIE_NAME } from "@/lib/panel-section-state";

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({
    openPanel: vi.fn(),
    notifyEntityMutated: vi.fn(),
    orgSlug: "acme",
    workspaceSlug: "product",
  }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }));
vi.mock("@/components/decisions/request-decision-link", () => ({
  RequestDecisionLink: () => null,
}));

// Solution panel children
vi.mock("@/components/discovery/add-evidence-dialog", () => ({
  AddEvidenceDialog: () => null,
}));
vi.mock("@/components/discovery/evidence-list", () => ({ EvidenceList: () => null }));
vi.mock("@/components/panels/solution-assumptions", () => ({
  SolutionAssumptions: () => null,
}));
vi.mock("@/components/panels/solution-plan-discussion", () => ({
  SolutionPlanDiscussion: () => null,
}));
vi.mock("@/components/panels/solution-artifacts", () => ({ SolutionArtifacts: () => null }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  promoteToRoadmap: vi.fn(),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/reviews/actions", () => ({
  requestBuildingInvestmentAction: vi.fn(),
}));

// Roadmap item panel children
vi.mock("@/components/panels/launch-checklist", () => ({ LaunchChecklist: () => null }));
vi.mock("@/components/panels/launch-tier-picker", () => ({ LaunchTierPicker: () => null }));
vi.mock("@/components/panels/positioning-brief-row", () => ({
  PositioningBriefRow: () => null,
}));
vi.mock("@/components/tasks/linked-tasks-section", () => ({
  LinkedTasksSection: () => null,
}));

import { SolutionPanel } from "@/components/panels/solution-panel";
import { RoadmapItemPanel } from "@/components/panels/roadmap-item-panel";

const solutionData = {
  id: "sol-1",
  title: "Guided setup",
  description: "A guided setup flow",
  status: "VALIDATED",
  opportunity: {
    id: "opp-1",
    title: "Setup is confusing",
    workspaceId: "ws-1",
    squadId: null,
  },
  assumptions: [{ id: "asm-1" }],
  evidence: [{ id: "ev-1" }],
  comments: [{ id: "c-1", commentType: "PLAN" }],
  roadmapItems: [{ id: "ri-1", title: "Ship guided setup", horizon: "NOW" }],
  artifacts: [{ id: "art-1" }],
  availableArtifacts: [],
  deliveryTasks: [],
  linkableTasks: [],
  members: [],
};

const roadmapItemData = {
  id: "ri-1",
  workspaceId: "ws-1",
  title: "Ship guided setup",
  description: "Ship it",
  horizon: "NOW",
  status: "IN_PROGRESS",
  isPrivate: false,
  startDate: null,
  endDate: null,
  updatedAt: "2026-09-07T00:00:00.000Z",
  squad: null,
  solution: { id: "sol-1", title: "Guided setup" },
  keyResult: null,
  opportunity: null,
  experiment: null,
  feedback: null,
  launchChecklist: null,
  positioningBrief: null,
  deliveryTasks: [{ id: "task-1" }],
  linkableTasks: [],
  members: [],
  _count: { votes: 0 },
};

function mockFetch(type: string, data: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ type, data }) })
    )
  );
}

async function expectSectionState(name: RegExp, expanded: "true" | "false") {
  const trigger = await screen.findByRole("button", { name });
  expect(trigger).toHaveAttribute("aria-expanded", expanded);
}

describe("per-panel-type section defaults", () => {
  beforeEach(() => {
    document.cookie = `${PANEL_SECTION_COOKIE_NAME}=; path=/; max-age=0`;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("opens Opportunity and Assumptions and closes the rest on a solution panel", async () => {
    mockFetch("solution", solutionData);
    render(<SolutionPanel id="sol-1" orgSlug="acme" workspaceSlug="product" />);

    await expectSectionState(/Opportunity/, "true");
    await expectSectionState(/Assumptions/, "true");
    await expectSectionState(/Evidence/, "false");
    await expectSectionState(/Roadmap/, "false");
    await expectSectionState(/Current Plan/, "false");
    await expectSectionState(/Artifacts/, "false");
  });

  it("opens Launch and Delivery tasks and closes Linked to on a roadmap item panel", async () => {
    mockFetch("roadmapItem", roadmapItemData);
    render(<RoadmapItemPanel id="ri-1" orgSlug="acme" workspaceSlug="product" />);

    await expectSectionState(/Launch/, "true");
    await expectSectionState(/Delivery tasks/, "true");
    await expectSectionState(/Linked to/, "false");
  });

  it("leaves untouched panels non-collapsible", async () => {
    mockFetch("solution", solutionData);
    render(<SolutionPanel id="sol-1" orgSlug="acme" workspaceSlug="product" />);

    // Investment decision is deliberately not part of the disclosure change,
    // standing in for the five panels (Objective, Key Result, Assumption,
    // Experiment, Feedback) that must keep rendering fully expanded.
    await screen.findByText(/Investment decision/);
    expect(
      screen.queryByRole("button", { name: /Investment decision/ })
    ).toBeNull();
  });
});
