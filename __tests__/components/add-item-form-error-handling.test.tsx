// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Regression test for a crash a QA pass found by screenshot: a read-only org
 * member (see the org-wide member read-only workspace access feature) can
 * open the Roadmap "Add item" form -- expected, this codebase deliberately
 * does not hide every write control for a read-only viewer -- but submitting
 * it threw an unhandled rejection (requireWorkspaceMember's bare
 * `Error("Workspace not found")`) straight into Next's raw runtime-error
 * overlay instead of a clean, expected message. Confirmed zero rows were
 * written either way; this is a UX/crash fix, not a security fix.
 */

const mockAddRoadmapItem = vi.hoisted(() => vi.fn());
vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/actions", () => ({
  addRoadmapItem: mockAddRoadmapItem,
}));

import { AddItemForm } from "@/components/roadmap/add-item-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddItemForm error handling", () => {
  it("shows an inline error instead of throwing when the action rejects", async () => {
    mockAddRoadmapItem.mockRejectedValue(new Error("Workspace not found"));

    render(<AddItemForm workspaceId="ws-1" horizon="NOW" revalidatePathStr="/acme/core/roadmap" />);

    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New roadmap item" } });
    fireEvent.submit(screen.getByLabelText("Title").closest("form")!);

    expect(await screen.findByText("Workspace not found")).toBeInTheDocument();
    // The form stays open with the entered title intact so the user can see
    // what failed, rather than being silently reset or torn down.
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
  });

  it("still succeeds normally when the action resolves", async () => {
    mockAddRoadmapItem.mockResolvedValue({
      id: "item-1",
      title: "New roadmap item",
      description: null,
      sortOrder: 0,
      isPrivate: false,
      solutionId: null,
      keyResultId: null,
      opportunityId: null,
      experimentId: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      startDate: null,
      endDate: null,
    });
    const onAdd = vi.fn();

    render(
      <AddItemForm workspaceId="ws-1" horizon="NOW" revalidatePathStr="/acme/core/roadmap" onAdd={onAdd} />
    );

    fireEvent.click(screen.getByRole("button", { name: "Add item" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New roadmap item" } });
    fireEvent.submit(screen.getByLabelText("Title").closest("form")!);

    await vi.waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(screen.queryByText("Workspace not found")).not.toBeInTheDocument();
  });
});
