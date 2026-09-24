// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const state = vi.hoisted(() => ({ data: {} as Record<string, unknown>, openPanel: vi.fn() }));
vi.mock("@/components/panels/panel-parts", async (original) => ({
  ...await original<typeof import("@/components/panels/panel-parts")>(),
  useEntityDetail: () => ({ data: state.data, mutate: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/panels/panel-context", () => ({ usePanelContext: () => ({ openPanel: state.openPanel, notifyEntityMutated: vi.fn() }) }));
vi.mock("@/components/comments/discussion", () => ({ Discussion: () => <div>Discussion</div> }));
vi.mock("@/components/tasks/task-links-panel", () => ({ TaskLinksPanel: () => <div>Linked work</div> }));
vi.mock("@/components/tasks/task-assignee-picker", () => ({ TaskAssigneePicker: () => <button>Assignee picker</button> }));
vi.mock("@/components/tasks/add-subtask-form", () => ({ AddSubtaskForm: () => <button>Add subtask</button> }));
vi.mock("@/components/custom-fields/custom-fields-panel", () => ({ CustomFieldsPanel: () => null }));
import { TaskDetail } from "@/components/tasks/task-detail";

beforeEach(() => {
  document.cookie = "panel_sections=; path=/; max-age=0";
  state.data = { id: "task-1", workspaceId: "ws", title: "Validate weekly digest", description: "Interview three readers", status: "TODO", priority: "MEDIUM", assigneeUserId: null, assigneeAgentId: null, ownerName: null, dueDate: null, storyPoints: 5, iteration: "Sprint 24", squadId: null, squads: [], members: [], links: [], subtasks: [], customFields: [], linkableTargets: {}, parentTask: null };
});
afterEach(cleanup);

it.each(["panel", "page"] as const)("keeps empty subtasks to one action and folds secondary fields in %s", (variant) => {
  render(<TaskDetail taskId="task-1" orgSlug="acme" workspaceSlug="product" variant={variant} />);
  expect(screen.queryByText("Subtasks")).toBeNull();
  expect(screen.queryByText("No subtasks yet.")).toBeNull();
  expect(screen.getByRole("button", { name: "Add subtask" })).toBeVisible();
  expect(screen.queryByText("Story points")).toBeNull();
  const disclosure = screen.getByRole("button", { name: "More properties" });
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(disclosure);
  expect(screen.getByText("Story points")).toBeVisible();
  expect(screen.getByText("Iteration")).toBeVisible();
  expect(screen.queryByText("Open full page")).toBeNull();
});

it("retains navigation for populated subtasks before secondary properties", () => {
  state.data.subtasks = [{ id: "subtask-1", title: "Interview a reader", status: "TODO" }];
  render(<TaskDetail taskId="task-1" orgSlug="acme" workspaceSlug="product" variant="panel" />);
  const child = screen.getByRole("button", { name: /Interview a reader/ });
  expect(child.compareDocumentPosition(screen.getByRole("button", { name: "More properties" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(child);
  expect(state.openPanel).toHaveBeenCalledWith("task", "subtask-1");
});
