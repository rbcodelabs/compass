// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import {
  EMPTY_EXPERIMENT_DRAFT,
  experimentComposerId,
  experimentDraftKey,
  presetAssumptionFromComposerId,
  serializeExperimentDraft,
} from "@/lib/experiment-draft";

const KEY = experimentDraftKey("acme", "core");
const SQUAD_ID = "5b0c7a6e-0000-4000-8000-000000000001";
let store: Map<string, string>;

function installLocalStorage() {
  store = new Map();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
    },
  });
}

const OPTIONS = {
  metrics: [
    { id: "m-1", name: "Daily visitors", unit: "visitors", provider: "vercel" },
    { id: "m-2", name: "Activation rate", unit: "%", provider: "compass_activation" },
  ],
  squads: [{ id: SQUAD_ID, name: "Growth", color: "#16a34a" }],
  assumptions: [
    { id: "as-1", title: "Users read the banner", solutionTitle: "Banner", opportunityTitle: "Awareness" },
    { id: "as-2", title: "Users trust the quote", solutionTitle: "Quote", opportunityTitle: "Trust" },
  ],
};

async function renderComposer(composerId = "new") {
  const utils = render(<ExperimentComposer orgSlug="acme" workspaceSlug="core" composerId={composerId} />);
  await screen.findByRole("form", { name: "New experiment" });
  // Pickers are ready once the options have loaded.
  await screen.findByRole("combobox", { name: /Testing assumption/ });
  // Let the open-time autofocus (a rAF) land before a test moves focus itself.
  await waitFor(() => expect(screen.getByLabelText("Title")).toHaveFocus());
  return utils;
}

const titleInput = () => screen.getByLabelText("Title");
const hypothesis = () => screen.getByLabelText("Hypothesis");
const method = () => screen.getByLabelText("Method");
const kill = () => screen.getByLabelText(/Kill Condition/);
const submitButton = () => screen.getByRole("button", { name: "Submit" });

function fillRequired() {
  fireEvent.change(titleInput(), { target: { value: "Banner copy test" } });
  fireEvent.change(hypothesis(), { target: { value: "We believe shorter copy wins." } });
  fireEvent.change(method(), { target: { value: "A/B test." } });
  fireEvent.change(kill(), { target: { value: "Stop if no lift after 14 days." } });
}

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorage();
  loadExperimentComposerOptions.mockResolvedValue({ ok: true, options: OPTIONS });
  createExperimentFromComposer.mockResolvedValue({ ok: true, experiment: { id: "exp-9", title: "x" }, unlinkedMetrics: [] });
});
afterEach(cleanup);

describe("experiment composer ids", () => {
  it("round-trips the preset assumption through the panel id", () => {
    expect(experimentComposerId()).toBe("new");
    expect(experimentComposerId("as-1")).toBe("new-as-1");
    expect(presetAssumptionFromComposerId("new")).toBeNull();
    expect(presetAssumptionFromComposerId("new-as-1")).toBe("as-1");
  });
});

describe("ExperimentComposer — fields", () => {
  it("renders an autofocused title, the three required text fields, and both optional pickers", async () => {
    await renderComposer();
    await waitFor(() => expect(titleInput()).toHaveFocus());
    expect(titleInput()).toHaveAttribute("maxLength", "255");
    expect(titleInput()).toHaveAttribute("placeholder", "What are you testing?");
    expect(hypothesis()).toHaveAttribute("placeholder", "We believe that...");
    expect(method()).toHaveAttribute("placeholder", "We will test this by...");
    expect(kill()).toHaveAttribute("placeholder", "We will kill this experiment if...");
    expect(screen.getByRole("combobox", { name: /Testing assumption/ })).toHaveTextContent("No assumption");
    expect(screen.getByRole("combobox", { name: /Squad/ })).toHaveTextContent("No squad");
    expect(loadExperimentComposerOptions).toHaveBeenCalledWith("acme", "core");
  });

  it("presets the tested assumption from the OST link's panel id", async () => {
    await renderComposer("new-as-2");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /Testing assumption/ })).toHaveTextContent("Users trust the quote"),
    );
    fillRequired();
    fireEvent.click(submitButton());
    await waitFor(() => expect(createExperimentFromComposer).toHaveBeenCalled());
    expect(createExperimentFromComposer.mock.calls[0][2]).toMatchObject({ assumptionId: "as-2" });
  });

  it("lets the link's preset win over the restored draft's assumption", async () => {
    store.set(KEY, serializeExperimentDraft({ ...EMPTY_EXPERIMENT_DRAFT, title: "t", assumptionId: "as-1" }));
    await renderComposer("new-as-2");
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: /Testing assumption/ })).toHaveTextContent("Users trust the quote"),
    );
    expect(titleInput()).toHaveValue("t");
  });

  it("shows the squad's name, never its id", async () => {
    store.set(KEY, serializeExperimentDraft({ ...EMPTY_EXPERIMENT_DRAFT, title: "t", squadId: SQUAD_ID }));
    await renderComposer();
    const squad = screen.getByRole("combobox", { name: /Squad/ });
    expect(squad).toHaveTextContent("Growth");
    expect(squad).not.toHaveTextContent(SQUAD_ID);
  });

  it("drops restored links that no longer exist once the options load", async () => {
    store.set(
      KEY,
      serializeExperimentDraft({
        ...EMPTY_EXPERIMENT_DRAFT,
        title: "Banner copy test",
        hypothesis: "h",
        method: "m",
        killCondition: "k",
        assumptionId: "as-gone",
        squadId: "sq-gone",
      }),
    );
    await renderComposer();
    fireEvent.click(submitButton());
    await waitFor(() => expect(createExperimentFromComposer).toHaveBeenCalled());
    expect(createExperimentFromComposer.mock.calls[0][2]).toMatchObject({ assumptionId: null, squadId: null });
  });

  it("still lets you create when the pickers' options fail to load", async () => {
    loadExperimentComposerOptions.mockResolvedValue({ ok: false, error: "nope" });
    render(<ExperimentComposer orgSlug="acme" workspaceSlug="core" composerId="new" />);
    expect(await screen.findByText(/Couldn't load assumptions and squads/)).toBeInTheDocument();
    fillRequired();
    fireEvent.click(submitButton());
    await waitFor(() => expect(createExperimentFromComposer).toHaveBeenCalled());
  });
});

describe("ExperimentComposer — metrics", () => {
  it("lists the workspace's metrics with unit and provider, unchecked by default", async () => {
    await renderComposer();
    const group = screen.getByRole("group", { name: /Metrics/ });
    expect(within(group).getByRole("checkbox", { name: /Daily visitors/ })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: /Activation rate/ })).not.toBeChecked();
    expect(group).toHaveTextContent("visitors");
    expect(screen.getByRole("link", { name: "Manage metrics" })).toHaveAttribute("href", "/acme/core/metrics");
  });

  it("sends the chosen metrics with the create request", async () => {
    await renderComposer();
    fillRequired();
    fireEvent.click(screen.getByRole("checkbox", { name: /Activation rate/ }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(createExperimentFromComposer).toHaveBeenCalled());
    expect(createExperimentFromComposer.mock.calls[0][2]).toMatchObject({ metricIds: ["m-2"] });
    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("experiment", "exp-9", { replace: true }));
  });

  it("restores chosen metrics from a draft and drops ones that no longer exist", async () => {
    store.set(KEY, serializeExperimentDraft({ ...EMPTY_EXPERIMENT_DRAFT, title: "t", metricIds: ["m-1", "m-gone"] }));
    await renderComposer();
    expect(screen.getByRole("checkbox", { name: /Daily visitors/ })).toBeChecked();
    fillRequired();
    fireEvent.click(submitButton());
    await waitFor(() => expect(createExperimentFromComposer).toHaveBeenCalled());
    expect(createExperimentFromComposer.mock.calls[0][2]).toMatchObject({ metricIds: ["m-1"] });
  });

  it("points at creating a metric when the workspace has none", async () => {
    loadExperimentComposerOptions.mockResolvedValue({ ok: true, options: { ...OPTIONS, metrics: [] } });
    await renderComposer();
    expect(screen.getByText(/No metrics are defined/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create a metric" })).toBeInTheDocument();
  });

  it("says which metrics could not be linked instead of handing off silently", async () => {
    createExperimentFromComposer.mockResolvedValue({
      ok: true,
      experiment: { id: "exp-9", title: "x" },
      unlinkedMetrics: ["Daily visitors"],
    });
    await renderComposer();
    fillRequired();
    fireEvent.click(screen.getByRole("checkbox", { name: /Daily visitors/ }));
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Daily visitors/);
    expect(openPanel).not.toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open experiment" }));
    expect(openPanel).toHaveBeenCalledWith("experiment", "exp-9", { replace: true });
  });
});

describe("ExperimentComposer — submit", () => {
  it.each([
    ["title", /Add a title/, () => titleInput()],
    ["hypothesis", /Add a hypothesis/, () => hypothesis()],
    ["method", /Add a method/, () => method()],
    ["kill condition", /Add a kill condition/, () => kill()],
  ] as const)("refuses a missing %s inline, focuses it, and never calls the server", async (_name, message, field) => {
    await renderComposer();
    fillRequired();
    fireEvent.change(field(), { target: { value: "   " } });
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(field()).toHaveFocus();
    expect(createExperimentFromComposer).not.toHaveBeenCalled();
  });

  it("submits on ⌘/Ctrl+Enter, then hands the slot to the created experiment and clears the draft", async () => {
    await renderComposer();
    fillRequired();
    expect(store.get(KEY)).toContain("Banner copy test");

    fireEvent.keyDown(titleInput(), { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("experiment", "exp-9", { replace: true }));
    expect(createExperimentFromComposer).toHaveBeenCalledWith("acme", "core", {
      title: "Banner copy test",
      hypothesis: "We believe shorter copy wins.",
      method: "A/B test.",
      killCondition: "Stop if no lift after 14 days.",
      squadId: null,
      assumptionId: null,
      metricIds: [],
    });
    expect(refresh).toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
  });

  it("shows the server's validation error inline and keeps the draft", async () => {
    createExperimentFromComposer.mockResolvedValue({ ok: false, error: "That assumption is not in this workspace." });
    await renderComposer();
    fillRequired();
    fireEvent.click(submitButton());
    expect(await screen.findByText("That assumption is not in this workspace.")).toBeInTheDocument();
    expect(openPanel).not.toHaveBeenCalled();
    expect(store.get(KEY)).toContain("Banner copy test");
  });

  it("turns a thrown server action into a readable error", async () => {
    createExperimentFromComposer.mockRejectedValue(new Error("network"));
    await renderComposer();
    fillRequired();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Couldn't create the experiment right now/)).toBeInTheDocument();
  });
});

describe("ExperimentComposer — draft safety", () => {
  it("restores a saved draft on the next open", async () => {
    const first = await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "Half-written" } });
    fireEvent.change(hypothesis(), { target: { value: "We believe..." } });
    first.unmount();

    await renderComposer();
    expect(titleInput()).toHaveValue("Half-written");
    expect(hypothesis()).toHaveValue("We believe...");
    expect(screen.getByRole("status")).toHaveTextContent(/Restored your unsent draft/);
  });

  it("closes without asking when there is nothing to lose", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(closePanel).toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirms before discarding a non-empty draft, and only then deletes it", async () => {
    await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "Precious" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Discard this draft/);
    expect(closePanel).not.toHaveBeenCalled();
    expect(store.get(KEY)).toContain("Precious");

    fireEvent.click(within(dialog).getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(closePanel).toHaveBeenCalled());
    expect(store.has(KEY)).toBe(false);
  });
});
