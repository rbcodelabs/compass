// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { openPanelMock, unlinkTaskMock, linkTaskMock } = vi.hoisted(() => ({
  openPanelMock: vi.fn(),
  unlinkTaskMock: vi.fn(),
  linkTaskMock: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/tasks/actions", () => ({
  unlinkTask: unlinkTaskMock,
  linkTask: linkTaskMock,
}));

vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel: openPanelMock }),
}));

import { TaskLinksPanel } from "@/components/tasks/task-links-panel";
import type { TaskLinkData } from "@/lib/types";

const baseLinks: TaskLinkData[] = [
  { id: "link-1", linkedType: "OPPORTUNITY", linkedId: "opp-1", linkedTitle: "Faster onboarding" },
  { id: "link-2", linkedType: "DOC", linkedId: "doc-1", linkedTitle: "Design spec" },
  { id: "link-3", linkedType: "DECISION", linkedId: "decision-1", linkedTitle: "Ship the export flow?" },
];

function renderPanel(links: TaskLinkData[] = baseLinks) {
  return render(
    <TaskLinksPanel
      taskId="task-1"
      initialLinks={links}
      revalidatePathStr="/rbcodelabs/compass/tasks/task-1"
      linkableTargets={{
        OPPORTUNITY: [{ id: "opp-1", title: "Faster onboarding" }],
        SOLUTION: [],
        ROADMAP_ITEM: [],
        OBJECTIVE: [],
        KEY_RESULT: [],
        DOC: [],
        EXPERIMENT: [],
        FEEDBACK_ITEM: [],
        DECISION: [],
      }}
      orgSlug="rbcodelabs"
      workspaceSlug="compass"
    />
  );
}

describe("TaskLinksPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not add a duplicate optimistic row when linking an existing target", async () => {
    linkTaskMock.mockResolvedValue({ id: "link-1" });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.click(screen.getByRole("option", { name: /Faster onboarding Opportunity/ }));
    fireEvent.click(screen.getByRole("button", { name: "Link item" }));

    await screen.findByText("Faster onboarding");
    expect(screen.getAllByText("Faster onboarding")).toHaveLength(1);
  });

  it("calls openPanel with the mapped panel type and linked id when a mapped link is clicked", () => {
    renderPanel();

    fireEvent.click(screen.getByText("Faster onboarding"));

    expect(openPanelMock).toHaveBeenCalledWith("opportunity", "opp-1");
  });

  it("renders a DOC link as a real anchor to the doc page instead of calling openPanel", () => {
    renderPanel();

    const docLink = screen.getByText("Design spec");
    expect(docLink.tagName).toBe("A");
    expect(docLink).toHaveAttribute("href", "/rbcodelabs/compass/docs/doc-1");

    fireEvent.click(docLink);
    expect(openPanelMock).not.toHaveBeenCalled();
  });

  it("renders a DECISION link as a real anchor to the review page instead of calling openPanel", () => {
    renderPanel();

    const decisionLink = screen.getByText("Ship the export flow?");
    expect(decisionLink.tagName).toBe("A");
    expect(decisionLink).toHaveAttribute("href", "/rbcodelabs/compass/reviews/decision-1");

    fireEvent.click(decisionLink);
    expect(openPanelMock).not.toHaveBeenCalled();
  });

  it("unlinks via the X button without triggering navigation", () => {
    renderPanel();

    fireEvent.click(screen.getByLabelText("Unlink Faster onboarding"));

    expect(unlinkTaskMock).toHaveBeenCalledWith("link-1", "/rbcodelabs/compass/tasks/task-1");
    expect(openPanelMock).not.toHaveBeenCalled();
  });

  it("renders COMMENT and AGENT_CONVERSATION origins in a non-removable 'Created from' section with clickable deep-links", () => {
    const commentLabel = 'Comment on OPP-7: "there is still a solution space…"';
    const docCommentLabel = "Comment on “REVIEW the rollout checklist”";
    renderPanel([
      {
        id: "origin-disc",
        linkedType: "COMMENT",
        linkedId: "cmt-disc",
        linkedTitle: commentLabel,
        isOrigin: true,
        linkedHref: "discovery/OPP-7?comment=cmt-disc",
      },
      {
        id: "origin-doc",
        linkedType: "COMMENT",
        linkedId: "cmt-doc",
        linkedTitle: docCommentLabel,
        isOrigin: true,
        linkedHref: "docs/DOC-3?comment=cmt-doc",
      },
      {
        id: "origin-conv",
        linkedType: "AGENT_CONVERSATION",
        linkedId: "conv-1",
        linkedTitle: "Triage sprint backlog",
        isOrigin: true,
      },
      ...baseLinks,
    ]);

    const originGroup = screen.getByTestId("task-origin-links");
    expect(within(originGroup).getByText("Created from")).toBeInTheDocument();

    const discAnchor = within(originGroup).getByRole("link", { name: commentLabel });
    expect(discAnchor).toHaveAttribute("href", "/rbcodelabs/compass/discovery/OPP-7?comment=cmt-disc");

    const docAnchor = within(originGroup).getByRole("link", { name: docCommentLabel });
    expect(docAnchor).toHaveAttribute("href", "/rbcodelabs/compass/docs/DOC-3?comment=cmt-doc");

    const convAnchor = within(originGroup).getByRole("link", { name: "Triage sprint backlog" });
    expect(convAnchor).toHaveAttribute("href", "/rbcodelabs/compass/agent?c=conv-1");

    // Origin links have no destructive 'x' unlink button, while reference links keep theirs.
    expect(screen.queryByLabelText(`Unlink ${commentLabel}`)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(`Unlink ${docCommentLabel}`)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Unlink Triage sprint backlog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Unlink Faster onboarding")).toBeInTheDocument();
  });

  it("degrades gracefully to non-clickable text when a COMMENT link's parent target no longer resolves", () => {
    const label = 'Comment on task: "Orphaned comment excerpt"';
    renderPanel([
      {
        id: "origin-dangling",
        linkedType: "COMMENT",
        linkedId: "cmt-orphan",
        linkedTitle: label,
        isOrigin: true,
        linkedHref: null,
      },
    ]);

    const originGroup = screen.getByTestId("task-origin-links");
    expect(within(originGroup).getByText(label).tagName).toBe("SPAN");
    expect(screen.queryByLabelText(`Unlink ${label}`)).not.toBeInTheDocument();
  });
});
