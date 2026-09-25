// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const { push, searchParams } = vi.hoisted(() => ({
  push: vi.fn(),
  searchParams: { current: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/rbcodelabs/compass/tasks",
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams.current,
  useParams: () => ({ orgSlug: "rbcodelabs", workspaceSlug: "compass" }),
}));

// The picker hook replaces its members fallback with this server result, so it
// has to describe the same person or the option list changes under the test.
vi.mock("@/lib/task-assignees-client", () => ({
  fetchTaskAssigneeOptions: vi.fn().mockResolvedValue([
    { type: "USER", id: "11111111-1111-1111-1111-111111111111", displayName: "Rick", available: true },
  ]),
}));

import { TasksFilters } from "@/components/tasks/tasks-filters";
import { UNASSIGNED_ASSIGNEE_FILTER } from "@/lib/task-assignee-display";
import type { MemberData } from "@/lib/types";

const members: MemberData[] = [
  { id: "m1", userId: "11111111-1111-1111-1111-111111111111", email: "rick@rbcodelabs.com", name: "Rick", role: "ADMIN" },
];

function openAssigneeMenu(query = "") {
  searchParams.current = new URLSearchParams(query);
  render(<TasksFilters squads={[]} members={members} />);
  fireEvent.click(screen.getByRole("button", { name: "Filters" }));
}

describe("TasksFilters assignee facet", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams.current = new URLSearchParams();
  });
  afterEach(() => cleanup());

  it("offers an Unassigned choice alongside the workspace people", async () => {
    openAssigneeMenu();
    expect(await screen.findByRole("menuitemradio", { name: "Unassigned" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Rick" })).toBeTruthy();
  });

  it("pushes the reserved sentinel when Unassigned is chosen", async () => {
    openAssigneeMenu();
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Unassigned" }));
    expect(push).toHaveBeenCalledWith(
      `/rbcodelabs/compass/tasks?assignee=${encodeURIComponent(UNASSIGNED_ASSIGNEE_FILTER)}`
    );
  });

  it("shows Unassigned as the selected choice when the sentinel is in the url", async () => {
    openAssigneeMenu(`assignee=${UNASSIGNED_ASSIGNEE_FILTER}`);
    const unassigned = await screen.findByRole("menuitemradio", { name: "Unassigned" });
    expect(unassigned.getAttribute("aria-checked")).toBe("true");
  });

  it("still marks a legacy bare-userId assignee param as selected", async () => {
    openAssigneeMenu(`assignee=${members[0].userId}`);
    const rick = await screen.findByRole("menuitemradio", { name: "Rick" });
    expect(rick.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Unassigned" }).getAttribute("aria-checked")).toBe("false");
  });
});
