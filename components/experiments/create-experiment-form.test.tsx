// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const createExperiment = vi.hoisted(() => vi.fn());
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({ createExperiment }));

import { CreateExperimentForm } from "./create-experiment-form";

beforeEach(() => createExperiment.mockReset().mockResolvedValue(undefined));
afterEach(cleanup);

describe("CreateExperimentForm", () => {
  it("is closed until the header button is used", async () => {
    render(<CreateExperimentForm workspaceId="ws-1" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New Experiment" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("New Experiment");
    expect(screen.getByRole("button", { name: "Create Experiment" })).toBeInTheDocument();
  });

  it("opens automatically when an assumption is prefilled", async () => {
    render(
      <CreateExperimentForm
        workspaceId="ws-1"
        prefillAssumptionId="as-1"
        assumptions={[{ id: "as-1", title: "Users want it", opportunityTitle: "Opp", solutionTitle: "Sol" } as never]}
      />,
    );
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("Cancel closes the dialog without creating", async () => {
    render(<CreateExperimentForm workspaceId="ws-1" />);
    fireEvent.click(screen.getByRole("button", { name: "New Experiment" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(createExperiment).not.toHaveBeenCalled();
  });
});
