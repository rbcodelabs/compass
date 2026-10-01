// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { refresh, openPanel, closePanel, createExperimentFromComposer, loadExperimentComposerOptions } = vi.hoisted(() => ({
  refresh: vi.fn(),
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  createExperimentFromComposer: vi.fn(),
  loadExperimentComposerOptions: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel, closePanel, panel: { type: "experiment-new", id: "new" } }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/experiments/actions", () => ({
  createExperimentFromComposer,
  loadExperimentComposerOptions,
}));

import { ExperimentComposer } from "@/components/experiments/experiment-composer";
import { experimentDraftKey, presetAssumptionFromComposerId, experimentComposerId } from "@/lib/experiment-draft";

const KEY = experimentDraftKey("acme", "core");
let store: Map<string, string>;

const OPTIONS = {
  squads: [],
  assumptions: [{ id: "as-1", title: "Users want X", solutionTitle: "Sol", opportunityTitle: "Opp" }],
};

async function renderComposer(composerId = "new") {
  render(<ExperimentComposer orgSlug="acme" workspaceSlug="core" composerId={composerId} />);
  await screen.findByRole("form", { name: "New experiment" });
  await waitFor(() => expect(loadExperimentComposerOptions).toHaveBeenCalled());
}

function fillAll() {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Does X increase Y" } });
  fireEvent.change(screen.getByLabelText("Hypothesis"), { target: { value: "We believe X causes Y" } });
  fireEvent.change(screen.getByLabelText("Method"), { target: { value: "Run a test" } });
  fireEvent.change(screen.getByLabelText("Kill Condition"), { target: { value: "No lift in 2 weeks" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  store = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
  loadExperimentComposerOptions.mockResolvedValue({ ok: true, options: OPTIONS });
  createExperimentFromComposer.mockResolvedValue({ ok: true, experiment: { id: "exp-9", title: "x" } });
});
afterEach(cleanup);

describe("ExperimentComposer", () => {
  it("rejects an empty submit without calling the server", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a title");
    expect(createExperimentFromComposer).not.toHaveBeenCalled();
  });

  it("submits, clears the draft and hands the panel to the new experiment", async () => {
    await renderComposer();
    fillAll();
    await waitFor(() => expect(store.has(KEY)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("experiment", "exp-9", { replace: true }));
    expect(createExperimentFromComposer).toHaveBeenCalledWith("acme", "core", expect.objectContaining({
      title: "Does X increase Y",
      killCondition: "No lift in 2 weeks",
      assumptionId: null,
    }));
    expect(store.has(KEY)).toBe(false);
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the server's error inline and keeps the draft", async () => {
    createExperimentFromComposer.mockResolvedValue({ ok: false, error: "Assumption not found in workspace" });
    await renderComposer();
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Assumption not found in workspace")).toBeInTheDocument();
    expect(openPanel).not.toHaveBeenCalled();
  });

  it("shows a calm message when the action rejects", async () => {
    createExperimentFromComposer.mockRejectedValue(new Error("boom"));
    await renderComposer();
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(/Your draft is saved on this device/)).toBeInTheDocument();
  });

  it("preselects the assumption from the panel id", async () => {
    await renderComposer("new-as-1");
    fillAll();
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() =>
      expect(createExperimentFromComposer).toHaveBeenCalledWith("acme", "core", expect.objectContaining({ assumptionId: "as-1" })),
    );
  });
});

describe("experiment composer ids", () => {
  it("round-trips an assumption preset", () => {
    expect(experimentComposerId()).toBe("new");
    expect(presetAssumptionFromComposerId("new")).toBeNull();
    expect(presetAssumptionFromComposerId(experimentComposerId("as-1"))).toBe("as-1");
  });
});
