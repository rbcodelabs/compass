// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { refresh, openPanel, closePanel, createOpportunityFromComposer, loadOpportunityComposerOptions } = vi.hoisted(() => ({
  refresh: vi.fn(),
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  createOpportunityFromComposer: vi.fn(),
  loadOpportunityComposerOptions: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel, closePanel, panel: { type: "opportunity-new", id: "new" } }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/discovery/actions", () => ({
  createOpportunityFromComposer,
  loadOpportunityComposerOptions,
}));

import { OpportunityComposer } from "@/components/discovery/opportunity-composer";
import { opportunityDraftKey, serializeOpportunityDraft, EMPTY_OPPORTUNITY_DRAFT } from "@/lib/opportunity-draft";

const KEY = opportunityDraftKey("acme", "core");
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
  squads: [{ id: SQUAD_ID, name: "Growth", color: "#16a34a" }],
  keyResults: [
    { id: "kr-1", title: "Activation to 40%", objectiveTitle: "Grow the base" },
    { id: "kr-2", title: "Churn under 2%", objectiveTitle: "Keep customers" },
  ],
  feedback: [
    { id: "fb-1", title: "Setup is confusing", type: "BUG", status: "OPEN", opportunity: null },
    { id: "fb-2", title: "Wish for templates", type: "IDEA", status: "UNDER_REVIEW", opportunity: { id: "opp-old", title: "Templates" } },
    { id: "fb-3", title: "Invite flow breaks", type: "BUG", status: "OPEN", opportunity: null },
  ],
};

async function renderComposer(composerId = "new") {
  const utils = render(<OpportunityComposer orgSlug="acme" workspaceSlug="core" composerId={composerId} />);
  await screen.findByRole("form", { name: "New opportunity" });
  // Pickers are ready once the options have loaded.
  await screen.findByRole("combobox", { name: "Key result" });
  return utils;
}

const titleInput = () => screen.getByLabelText("Title");
const submitButton = () => screen.getByRole("button", { name: "Submit" });

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorage();
  loadOpportunityComposerOptions.mockResolvedValue({ ok: true, options: OPTIONS });
  createOpportunityFromComposer.mockResolvedValue({ ok: true, opportunity: { id: "opp-9", title: "x" } });
});
afterEach(cleanup);

describe("OpportunityComposer — fields", () => {
  it("renders a large autofocused title, Markdown description, segment, status, squad and both pickers — and no attachments", async () => {
    await renderComposer();
    await waitFor(() => expect(titleInput()).toHaveFocus());
    expect(titleInput()).toHaveAttribute("maxLength", "255");
    expect(screen.getByRole("textbox", { name: "Description" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Customer segment/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Exploring");
    expect(screen.getByRole("combobox", { name: "Squad" })).toHaveTextContent("No squad");
    expect(screen.getByRole("combobox", { name: "Key result" })).toHaveTextContent("Link a key result");
    expect(screen.getByRole("combobox", { name: "Seed from feedback" })).toBeInTheDocument();
    expect(screen.queryByText(/Attachments/)).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(loadOpportunityComposerOptions).toHaveBeenCalledWith("acme", "core");
  });

  it("shows a counter only as the title nears 255", async () => {
    await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "x".repeat(10) } });
    expect(screen.queryByText("10/255")).toBeNull();
    fireEvent.change(titleInput(), { target: { value: "x".repeat(210) } });
    expect(screen.getByText("210/255")).toBeInTheDocument();
  });

  it("presets the status from the board column it was opened from", async () => {
    await renderComposer("new-validating");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Validating");
  });

  it("shows the squad's name — never its id — with its colour dot", async () => {
    store.set(KEY, serializeOpportunityDraft({ ...EMPTY_OPPORTUNITY_DRAFT, title: "t", squadId: SQUAD_ID }));
    await renderComposer();
    const squad = screen.getByRole("combobox", { name: "Squad" });
    expect(squad).toHaveTextContent("Growth");
    expect(squad).not.toHaveTextContent(SQUAD_ID);
  });

  it("inserts the opportunity outline into the Markdown body with one click", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("button", { name: /Insert opportunity outline/ }));
    for (const heading of ["Who's affected", "Current pain", "Evidence", "Desired outcome"]) {
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
  });
});

describe("OpportunityComposer — links", () => {
  it("links a Key Result chosen from the workspace's KRs", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("combobox", { name: "Key result" }));
    fireEvent.click(await screen.findByRole("option", { name: /Churn under 2%/ }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Key result" })).toHaveTextContent("Churn under 2%"));

    fireEvent.change(titleInput(), { target: { value: "Retention risk" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(createOpportunityFromComposer).toHaveBeenCalled());
    expect(createOpportunityFromComposer.mock.calls[0][2]).toMatchObject({ linkedKeyResultId: "kr-2" });
  });

  it("seeds from several searched feedback items, shows them as removable chips, and flags re-links", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("combobox", { name: "Seed from feedback" }));
    const search = await screen.findByPlaceholderText("Search feedback…");
    fireEvent.change(search, { target: { value: "templates" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.click(screen.getByRole("option", { name: /Wish for templates/ }));
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.click(await screen.findByRole("option", { name: /Setup is confusing/ }));

    const chips = await screen.findByRole("list", { name: "Selected feedback" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/1 is linked to another opportunity and will move here/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove Wish for templates" }));
    expect(within(chips).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.change(titleInput(), { target: { value: "Setup friction" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(createOpportunityFromComposer).toHaveBeenCalled());
    expect(createOpportunityFromComposer.mock.calls[0][2]).toMatchObject({ feedbackIds: ["fb-1"] });
  });

  it("drops restored links that no longer exist once the options load", async () => {
    store.set(
      KEY,
      serializeOpportunityDraft({ ...EMPTY_OPPORTUNITY_DRAFT, title: "t", keyResultId: "kr-gone", squadId: "sq-gone", feedbackIds: ["fb-3", "fb-gone"] }),
    );
    await renderComposer();
    fireEvent.click(submitButton());
    await waitFor(() => expect(createOpportunityFromComposer).toHaveBeenCalled());
    expect(createOpportunityFromComposer.mock.calls[0][2]).toMatchObject({
      squadId: null,
      linkedKeyResultId: null,
      feedbackIds: ["fb-3"],
    });
  });

  it("still lets you create when the pickers' options fail to load", async () => {
    loadOpportunityComposerOptions.mockResolvedValue({ ok: false, error: "nope" });
    render(<OpportunityComposer orgSlug="acme" workspaceSlug="core" composerId="new" />);
    expect(await screen.findByText(/Couldn't load key results and feedback/)).toBeInTheDocument();
    fireEvent.change(titleInput(), { target: { value: "Still works" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(createOpportunityFromComposer).toHaveBeenCalled());
  });
});

describe("OpportunityComposer — submit", () => {
  it("refuses an empty title inline, focuses it, and never calls the server", async () => {
    await renderComposer();
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Add a title/);
    expect(titleInput()).toHaveAttribute("aria-invalid", "true");
    expect(titleInput()).toHaveFocus();
    expect(createOpportunityFromComposer).not.toHaveBeenCalled();
  });

  it("submits on ⌘/Ctrl+Enter, then hands the slot to the created opportunity and clears the draft", async () => {
    await renderComposer("new-prioritized");
    fireEvent.change(titleInput(), { target: { value: "Onboarding stalls" } });
    fireEvent.change(screen.getByLabelText(/Customer segment/), { target: { value: "SMB admins" } });
    expect(store.get(KEY)).toContain("Onboarding stalls");

    fireEvent.keyDown(titleInput(), { key: "Enter", ctrlKey: true });

    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("opportunity", "opp-9", { replace: true }));
    expect(createOpportunityFromComposer).toHaveBeenCalledWith("acme", "core", {
      title: "Onboarding stalls",
      description: "",
      customerSegment: "SMB admins",
      status: "PRIORITIZED",
      squadId: null,
      linkedKeyResultId: null,
      feedbackIds: [],
    });
    expect(refresh).toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
  });

  it("shows the server's validation error inline and keeps the draft", async () => {
    createOpportunityFromComposer.mockResolvedValue({ ok: false, error: "That key result is not in this workspace." });
    await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "Keep me" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText("That key result is not in this workspace.")).toBeInTheDocument();
    expect(openPanel).not.toHaveBeenCalled();
    expect(store.get(KEY)).toContain("Keep me");
  });

  it("turns a thrown server action into a readable error", async () => {
    createOpportunityFromComposer.mockRejectedValue(new Error("network"));
    await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "x" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Couldn't create the opportunity right now/)).toBeInTheDocument();
  });
});

describe("OpportunityComposer — draft safety", () => {
  it("restores a saved draft on the next open", async () => {
    const first = await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "Half-written" } });
    fireEvent.change(screen.getByLabelText(/Customer segment/), { target: { value: "Enterprise" } });
    first.unmount();

    await renderComposer();
    expect(titleInput()).toHaveValue("Half-written");
    expect(screen.getByLabelText(/Customer segment/)).toHaveValue("Enterprise");
    expect(screen.getByRole("status")).toHaveTextContent(/Restored your unsent draft/);
  });

  it("lets a column's preset win over the restored draft's status", async () => {
    store.set(KEY, serializeOpportunityDraft({ ...EMPTY_OPPORTUNITY_DRAFT, title: "t", status: "ACTIVE" }));
    await renderComposer("new-validating");
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent("Validating");
    expect(titleInput()).toHaveValue("t");
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
