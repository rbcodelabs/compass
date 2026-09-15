// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { OpportunityHeader } from "@/components/discovery/opportunity-header";
import { OpportunityPanel } from "@/components/panels/opportunity-panel";
import { LinkedFeedback } from "@/components/discovery/linked-feedback";

const { openPanel, detail } = vi.hoisted(() => ({ openPanel: vi.fn(), detail: { data: {} as Record<string, unknown> } }));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel }) }));
vi.mock("@/components/panels/panel-parts", async (load) => ({
  ...await load<typeof import("@/components/panels/panel-parts")>(),
  useEntityDetail: () => ({ data: detail.data, mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({ updateOpportunityStatus: vi.fn(), linkOpportunityToKeyResult: vi.fn() }));
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => null }));
vi.mock("@/components/squads/squad-picker", () => ({ SquadPicker: () => null }));
vi.mock("@/components/discovery/evidence-list", () => ({ EvidenceList: () => null }));
vi.mock("@/components/discovery/add-solution-form", () => ({ AddSolutionForm: () => null }));
vi.mock("@/components/discovery/add-evidence-dialog", () => ({ AddEvidenceDialog: () => null }));
vi.mock("@/components/decisions/request-decision-link", () => ({ RequestDecisionLink: () => null }));
// LinkedTasksSection pulls in the real "use server" tasks actions module,
// which imports next-auth's `@/auth` — a real dependency this jsdom-environment
// component test has no business loading (same reasoning as every other real
// child component mocked above). Without this, next-auth's ESM `next/server`
// import fails to resolve under Vitest's jsdom transform.
vi.mock("@/components/tasks/linked-tasks-section", () => ({ LinkedTasksSection: () => null }));

const opportunity = {
  id: "opp", title: "Understand launch needs", description: null, customerSegment: null,
  status: "EXPLORING" as const, squadId: null,
  linkedKeyResult: { id: "kr", title: "Increase active teams", objective: { title: "Improve adoption" } },
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("opportunity relationships", () => {
  it("keeps future feedback statuses readable and navigable", () => {
    render(<LinkedFeedback feedback={[{ id: "future", title: "Future feedback", type: "IDEA", status: "FUTURE_STATUS" }]} />);
    fireEvent.click(screen.getByRole("button", { name: /FUTURE_STATUS\s*Future feedback/ }));
    expect(openPanel).toHaveBeenCalledWith("feedback", "future");
  });
  it("opens the driving KR from the full-page header", () => {
    render(<OpportunityHeader opportunity={opportunity} availableKeyResults={[]} squads={[]} revalidatePathStr="/discovery/opp" />);
    fireEvent.click(screen.getByRole("button", { name: "Increase active teams" }));
    expect(openPanel).toHaveBeenCalledWith("keyResult", "kr");
    expect(screen.getByText("Improve adoption")).toBeVisible();
  });

  it("renders linked feedback and friendly statuses in the panel and opens both relationship types", () => {
    detail.data = { ...opportunity, workspaceId: "ws", solutions: [], evidence: [], feedback: [
      { id: "fb", title: "Make launch stages optional for discovery teams with long planning cycles", type: "IDEA", status: "UNDER_REVIEW" },
      { id: "fb2", title: "Second signal", type: "BUG", status: "PLANNED" },
    ], deliveryTasks: [], linkableTasks: [], members: [] };
    render(<OpportunityPanel opportunityId="opp" orgSlug="org" workspaceSlug="ws" />);
    expect(screen.getByText(/Linked feedback/)).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: /Under review.*Make launch stages/i }));
    expect(openPanel).toHaveBeenCalledWith("feedback", "fb");
    fireEvent.click(screen.getByRole("button", { name: "Increase active teams" }));
    expect(openPanel).toHaveBeenLastCalledWith("keyResult", "kr");
  });

  it("shows explicit empty feedback and KR states", () => {
    detail.data = { ...opportunity, linkedKeyResult: null, workspaceId: "ws", solutions: [], evidence: [], feedback: [], deliveryTasks: [], linkableTasks: [], members: [] };
    render(<OpportunityPanel opportunityId="opp" orgSlug="org" workspaceSlug="ws" />);
    expect(screen.getByText("No feedback linked.")).toBeVisible();
    expect(screen.getByText("No key result linked.")).toBeVisible();
  });
});
