// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  measurement: vi.fn(),
  details: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@/components/analytics/measurements-panel", () => ({
  MeasurementsPanel: (props: unknown) => { mocks.measurement(props); return null; },
}));
vi.mock("@/components/panels/panel-parts", async (load) => ({
  ...(await load<typeof import("@/components/panels/panel-parts")>()),
  useEntityDetail: (type: string) => ({ data: mocks.details.get(type), error: false, mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: vi.fn(), notifyEntityMutated: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }));
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => null }));
vi.mock("@/components/research/flesh-this-out-link", () => ({ FleshThisOutLink: () => null }));
vi.mock("@/components/research/pm-interview-history", () => ({ PmInterviewHistory: () => null }));
vi.mock("@/components/research/experiment-research-links-section", () => ({ ExperimentResearchLinksSection: () => null }));
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => null }));
vi.mock("@/components/panels/launch-tier-picker", () => ({ LaunchTierPicker: () => null }));
vi.mock("@/components/panels/launch-checklist", () => ({ LaunchChecklist: () => null }));
vi.mock("@/components/panels/positioning-brief-row", () => ({ PositioningBriefRow: () => null }));
vi.mock("@/components/custom-fields/custom-fields-panel", () => ({ CustomFieldsPanel: () => null }));

import { ExperimentPanel } from "@/components/panels/experiment-panel";
import { RoadmapItemPanel } from "@/components/panels/roadmap-item-panel";
import { KeyResultPanel } from "@/components/panels/key-result-panel";

const shared = { orgSlug: "acme", workspaceSlug: "product" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  mocks.details.clear();
});

describe("measurement host wiring", () => {
  it.each([
    ["experiment", "EXPERIMENT", "experiment-1"],
    ["roadmapItem", "ROADMAP_ITEM", "roadmap-1"],
    ["keyResult", "KEY_RESULT", "key-result-1"],
  ] as const)("mounts the shared panel for %s with its persisted entity identity", async (type, targetType, targetId) => {
    if (type === "experiment") {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: experiment(targetId) }) }));
      render(<ExperimentPanel experimentId={targetId} {...shared} />);
    } else if (type === "roadmapItem") {
      mocks.details.set(type, roadmap(targetId));
      render(<RoadmapItemPanel id={targetId} {...shared} />);
    } else {
      mocks.details.set(type, keyResult(targetId));
      render(<KeyResultPanel id={targetId} {...shared} />);
    }

    await waitFor(() => expect(mocks.measurement).toHaveBeenCalledWith({
      ...shared,
      target: { targetType, targetId },
      compact: true,
    }));
  });
});

function experiment(id: string) {
  return { id, title: "Experiment", status: "DESIGNING", hypothesis: "Hypothesis", method: "Method", killCondition: "Stop", conclusion: null, conclusionReason: null, startDate: null, endDate: null, assumption: null, results: [], deliveryTasks: [], linkableTasks: [], members: [], pmInterviews: [], pmInterviewEnabled: false };
}

function roadmap(id: string) {
  return { id, workspaceId: "workspace-1", title: "Roadmap item", description: null, horizon: "NOW", status: "ACTIVE", isPrivate: false, startDate: null, endDate: null, updatedAt: "2026-09-23T00:00:00.000Z", squad: null, solution: null, keyResult: null, opportunity: null, experiment: null, feedback: null, launchChecklist: null, positioningBrief: null, launchWorkflowEnabled: false, deliveryTasks: [], linkableTasks: [], members: [], customFields: [], _count: { votes: 0 } };
}

function keyResult(id: string) {
  return { id, title: "Key result", current: 1, target: 2, unit: null, objective: null, checkIns: [], roadmapItems: [], opportunities: [], supportingObjectives: [], deliveryTasks: [], linkableTasks: [], members: [] };
}
