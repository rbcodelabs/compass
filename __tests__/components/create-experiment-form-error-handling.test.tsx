// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * Same class of bug as add-item-form-error-handling.test.tsx, found while
 * checking whether the "requireProductWorkspace throws a bare Error with no
 * catch at the call site" pattern was shared beyond Roadmap. It is:
 * createExperiment (experiments/actions.ts) calls
 * requireProductWorkspace (lib/product-action-auth.ts), which also throws a
 * bare Error, and this form's submit handler had no try/catch either.
 */

const mockCreateExperiment = vi.hoisted(() => vi.fn());
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({
  createExperiment: mockCreateExperiment,
}));

import { CreateExperimentForm } from "@/components/experiments/create-experiment-form";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fillAndSubmit() {
  fireEvent.click(screen.getByRole("button", { name: /New Experiment/ }));
  fireEvent.change(screen.getByPlaceholderText("What are you testing?"), {
    target: { value: "Does X increase Y" },
  });
  fireEvent.change(screen.getByPlaceholderText("We believe that..."), {
    target: { value: "We believe X causes Y" },
  });
  fireEvent.change(screen.getByPlaceholderText("We will test this by..."), {
    target: { value: "Running a test" },
  });
  fireEvent.change(screen.getByPlaceholderText("We will kill this experiment if..."), {
    target: { value: "No lift after 2 weeks" },
  });
  fireEvent.submit(screen.getByPlaceholderText("What are you testing?").closest("form")!);
}

describe("CreateExperimentForm error handling", () => {
  it("shows an inline error instead of throwing when the action rejects", async () => {
    mockCreateExperiment.mockRejectedValue(new Error("Workspace not found or access denied"));

    render(<CreateExperimentForm workspaceId="ws-1" />);
    fillAndSubmit();

    expect(await screen.findByText("Workspace not found or access denied")).toBeInTheDocument();
  });

  it("still succeeds normally when the action resolves", async () => {
    mockCreateExperiment.mockResolvedValue({ id: "exp-1" });

    render(<CreateExperimentForm workspaceId="ws-1" />);
    fillAndSubmit();

    await vi.waitFor(() => expect(mockCreateExperiment).toHaveBeenCalled());
    expect(screen.queryByText("Workspace not found or access denied")).not.toBeInTheDocument();
  });
});
