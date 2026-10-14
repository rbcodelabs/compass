// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { NewSolutionDialog } from "@/components/solutions/new-solution-dialog";

const addSolution = vi.hoisted(() => vi.fn());
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({ addSolution }));

const opportunities = [
  { id: "o1", title: "Slow onboarding" },
  { id: "o2", title: "Churn" },
];

beforeEach(() => addSolution.mockResolvedValue({ id: "new" }));
afterEach(() => {
  cleanup();
  addSolution.mockReset();
});

function open(props: Partial<React.ComponentProps<typeof NewSolutionDialog>> = {}) {
  render(<NewSolutionDialog opportunities={opportunities} orgSlug="org" workspaceSlug="ws" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "New Solution" }));
}

async function chooseParent(title: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Opportunity" }));
  const option = await screen.findByRole("option", { name: title });
  // Base UI ignores a bare click on an option; it wants the full pointer sequence.
  fireEvent.pointerDown(option);
  fireEvent.mouseDown(option);
  fireEvent.pointerUp(option);
  fireEvent.mouseUp(option);
  fireEvent.click(option);
}

describe("NewSolutionDialog", () => {
  it("requires a parent opportunity and a title before it can submit", async () => {
    open();
    const submit = screen.getByRole("button", { name: "Add Solution" });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Guided tour" } });
    expect(submit).toBeDisabled();

    await chooseParent("Churn");
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it("creates through addSolution under the chosen parent and revalidates /solutions", async () => {
    open();
    await chooseParent("Churn");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  Win-back email  " } });
    fireEvent.change(screen.getByLabelText("Description (optional)"), { target: { value: "  Nudge lapsed users " } });
    fireEvent.click(screen.getByRole("button", { name: "Add Solution" }));

    await waitFor(() =>
      expect(addSolution).toHaveBeenCalledWith("o2", { title: "Win-back email", description: "Nudge lapsed users" }, "/org/ws/solutions")
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("omits an empty description", async () => {
    open();
    await chooseParent("Slow onboarding");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Tour" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Solution" }));
    await waitFor(() => expect(addSolution).toHaveBeenCalledWith("o1", { title: "Tour", description: undefined }, "/org/ws/solutions"));
  });

  it("keeps the dialog open and shows an error when the action fails", async () => {
    addSolution.mockRejectedValue(new Error("nope"));
    open();
    await chooseParent("Churn");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Tour" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Solution" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not add this solution");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("explains when the workspace has no opportunity to add under", () => {
    open({ opportunities: [] });
    expect(screen.getByText("Add one in Discovery first.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Solution" })).toBeDisabled();
  });
});
