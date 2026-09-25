// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const { refresh, openPanel, closePanel, createFeedback } = vi.hoisted(() => ({
  refresh: vi.fn(),
  openPanel: vi.fn(),
  closePanel: vi.fn(),
  createFeedback: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ openPanel, closePanel, panel: { type: "feedback-new", id: "new" } }),
}));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/feedback/actions", () => ({
  createFeedback,
  prepareFeedbackAttachment: vi.fn(),
  discardFeedbackAttachment: vi.fn(),
}));

import { FeedbackComposer } from "@/components/feedback/feedback-composer";
import type { AttachmentTransport } from "@/components/feedback/use-feedback-attachment-uploads";
import { feedbackDraftKey } from "@/lib/feedback-draft";

const KEY = feedbackDraftKey("acme", "core");
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

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTransport() {
  const uploads: Array<{ pathname: string; progress: (n: number) => void; done: Deferred<{ url: string }> }> = [];
  const transport: AttachmentTransport = {
    prepare: vi.fn(async (file) => ({
      ok: true as const,
      upload: { clientToken: "tok", receipt: `receipt-${file.filename}`, pathname: `feedback/ws/${file.filename}`, expiresAt: Date.now() + 600_000 },
    })),
    upload: vi.fn((pathname, _file, { onProgress }) => {
      const done = deferred<{ url: string }>();
      uploads.push({ pathname, progress: onProgress, done });
      return done.promise;
    }),
    discard: vi.fn(async () => ({ ok: true })),
  };
  return { transport, uploads };
}

const png = (name = "shot.png") => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });

async function renderComposer(transport?: AttachmentTransport) {
  const utils = render(<FeedbackComposer orgSlug="acme" workspaceSlug="core" transport={transport} />);
  await screen.findByRole("radiogroup", { name: "Feedback type" });
  return utils;
}

const titleInput = () => screen.getByLabelText("Title");
const submitButton = () => screen.getByRole("button", { name: "Submit" });

beforeEach(() => {
  vi.clearAllMocks();
  installLocalStorage();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  createFeedback.mockResolvedValue({ ok: true, item: { id: "fb-9" } });
});
afterEach(cleanup);

describe("FeedbackComposer — type", () => {
  it("is a radiogroup of two cards, Idea by default, not a dropdown", async () => {
    await renderComposer();
    const group = screen.getByRole("radiogroup", { name: "Feedback type" });
    const idea = within(group).getByRole("radio", { name: /Idea.*Suggest an improvement/ });
    const bug = within(group).getByRole("radio", { name: /Bug.*Something isn't working/ });
    expect(idea).toHaveAttribute("aria-checked", "true");
    expect(bug).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("uses roving focus with arrow keys and adapts the guidance to the type", async () => {
    await renderComposer();
    const idea = screen.getByRole("radio", { name: /Idea/ });
    expect(idea).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: /Insert idea outline/ })).toBeInTheDocument();

    fireEvent.keyDown(idea, { key: "ArrowRight" });
    const bug = screen.getByRole("radio", { name: /Bug/ });
    expect(bug).toHaveAttribute("aria-checked", "true");
    expect(bug).toHaveFocus();
    expect(bug).toHaveAttribute("tabindex", "0");
    expect(idea).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: /Insert bug template/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(document.querySelector(".ProseMirror p")?.getAttribute("data-placeholder")).toMatch(/steps to reproduce/i),
    );
    expect(titleInput()).toHaveAttribute("placeholder", "What's broken?");
  });

  it("inserts the bug template into the Markdown body with one click", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("radio", { name: /Bug/ }));
    fireEvent.click(screen.getByRole("button", { name: /Insert bug template/ }));
    expect(await screen.findByRole("heading", { name: "Steps to reproduce" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Expected result" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Actual result" })).toBeInTheDocument();
  });
});

describe("FeedbackComposer — submit", () => {
  it("refuses an empty title inline, focuses it, and never calls the server", async () => {
    await renderComposer();
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(/Add a title/);
    expect(titleInput()).toHaveAttribute("aria-invalid", "true");
    expect(titleInput()).toHaveFocus();
    expect(createFeedback).not.toHaveBeenCalled();
  });

  it("submits on ⌘/Ctrl+Enter, then hands the slot to the created item and clears the draft", async () => {
    await renderComposer();
    fireEvent.click(screen.getByRole("radio", { name: /Bug/ }));
    fireEvent.change(titleInput(), { target: { value: "Export crashes" } });
    expect(store.get(KEY)).toContain("Export crashes");

    fireEvent.keyDown(titleInput(), { key: "Enter", metaKey: true });

    await waitFor(() => expect(openPanel).toHaveBeenCalledWith("feedback", "fb-9", { replace: true }));
    expect(createFeedback).toHaveBeenCalledWith(
      "acme",
      "core",
      { title: "Export crashes", description: "", type: "BUG", attachments: [] },
      "/acme/core/feedback",
    );
    expect(refresh).toHaveBeenCalled();
    expect(store.has(KEY)).toBe(false);
  });

  it("keeps the draft and shows the server's error when the create fails", async () => {
    createFeedback.mockResolvedValue({ ok: false, error: "Workspace not found" });
    await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "Keep me" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText("Workspace not found")).toBeInTheDocument();
    expect(openPanel).not.toHaveBeenCalled();
    expect(store.get(KEY)).toContain("Keep me");
  });

  it("turns a thrown server action into a readable error instead of an unhandled rejection", async () => {
    createFeedback.mockRejectedValue(new Error("network"));
    await renderComposer();
    fireEvent.change(titleInput(), { target: { value: "x" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Couldn't submit right now/)).toBeInTheDocument();
  });
});

describe("FeedbackComposer — draft safety", () => {
  it("restores a saved draft on the next open", async () => {
    const first = await renderComposer();
    fireEvent.click(screen.getByRole("radio", { name: /Bug/ }));
    fireEvent.change(titleInput(), { target: { value: "Half-written" } });
    first.unmount();

    await renderComposer();
    expect(titleInput()).toHaveValue("Half-written");
    expect(screen.getByRole("radio", { name: /Bug/ })).toHaveAttribute("aria-checked", "true");
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

describe("FeedbackComposer — attachments", () => {
  const fileInput = () => screen.getByTestId("feedback-composer-file-input") as HTMLInputElement;

  it("uploads on add, shows progress, and sends the finished upload with the submit", async () => {
    const { transport, uploads } = makeTransport();
    await renderComposer(transport);

    fireEvent.change(fileInput(), { target: { files: [png()] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    act(() => uploads[0].progress(42));
    expect(await screen.findByRole("progressbar", { name: "Uploading shot.png" })).toHaveAttribute("aria-valuenow", "42");
    expect(submitButton()).toBeDisabled();

    await act(async () => uploads[0].done.resolve({ url: "https://s.public.blob.vercel-storage.com/feedback/ws/shot.png" }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByTestId("feedback-composer-attachment")).toHaveAttribute("data-status", "done");

    fireEvent.change(titleInput(), { target: { value: "With a screenshot" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(createFeedback).toHaveBeenCalled());
    expect(createFeedback.mock.calls[0][2].attachments).toEqual([
      { url: "https://s.public.blob.vercel-storage.com/feedback/ws/shot.png", receipt: "receipt-shot.png" },
    ]);
    // Blobs now belong to the new item — they must not be deleted.
    expect(transport.discard).not.toHaveBeenCalled();
  });

  it("accepts a pasted screenshot as an attachment", async () => {
    const { transport, uploads } = makeTransport();
    await renderComposer(transport);
    fireEvent.paste(titleInput(), { clipboardData: { files: [png("pasted.png")], items: [], types: ["Files"] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(screen.getByText("pasted.png")).toBeInTheDocument();
  });

  it("accepts files dropped anywhere on the panel", async () => {
    const { transport, uploads } = makeTransport();
    await renderComposer(transport);
    const form = screen.getByRole("form", { name: "New feedback" });
    const dataTransfer = { files: [png("dropped.png")], types: ["Files"], dropEffect: "none" };
    fireEvent.dragEnter(form, { dataTransfer });
    expect(screen.getByText("Drop to attach")).toBeInTheDocument();
    fireEvent.drop(form, { dataTransfer });
    await waitFor(() => expect(uploads).toHaveLength(1));
    expect(screen.queryByText("Drop to attach")).toBeNull();
  });

  it("rejects unsupported files before uploading and says why", async () => {
    const { transport } = makeTransport();
    await renderComposer(transport);
    fireEvent.change(fileInput(), { target: { files: [new File(["x"], "tool.exe", { type: "application/x-msdownload" })] } });
    expect(await screen.findByText(/tool\.exe: unsupported file type/)).toBeInTheDocument();
    expect(transport.prepare).not.toHaveBeenCalled();
  });

  it("marks a failed upload, blocks submit, and lets the user retry it", async () => {
    const { transport, uploads } = makeTransport();
    await renderComposer(transport);
    fireEvent.change(fileInput(), { target: { files: [png()] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].done.reject(new Error("Network down")));

    const chip = screen.getByTestId("feedback-composer-attachment");
    expect(chip).toHaveAttribute("data-status", "error");
    expect(within(chip).getByText("Network down")).toBeInTheDocument();

    fireEvent.change(titleInput(), { target: { value: "t" } });
    fireEvent.click(submitButton());
    expect(await screen.findByText(/Remove or retry the attachments/)).toBeInTheDocument();
    expect(createFeedback).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry shot.png" }));
    await waitFor(() => expect(uploads).toHaveLength(2));
    await act(async () => uploads[1].done.resolve({ url: "https://s.public.blob.vercel-storage.com/x.png" }));
    expect(screen.getByTestId("feedback-composer-attachment")).toHaveAttribute("data-status", "done");
  });

  it("removes a finished upload and deletes its blob", async () => {
    const { transport, uploads } = makeTransport();
    await renderComposer(transport);
    fireEvent.change(fileInput(), { target: { files: [png()] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].done.resolve({ url: "https://s.public.blob.vercel-storage.com/y.png" }));

    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    expect(screen.queryByTestId("feedback-composer-attachment")).toBeNull();
    expect(transport.discard).toHaveBeenCalledWith({ url: "https://s.public.blob.vercel-storage.com/y.png", receipt: "receipt-shot.png" });
  });

  it("flags the exact attachment the server refused, keeping everything else", async () => {
    const { transport, uploads } = makeTransport();
    const url = "https://s.public.blob.vercel-storage.com/z.png";
    createFeedback.mockResolvedValue({ ok: false, error: "One attachment could not be verified.", attachmentUrl: url });
    await renderComposer(transport);
    fireEvent.change(fileInput(), { target: { files: [png()] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].done.resolve({ url }));
    fireEvent.change(titleInput(), { target: { value: "t" } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(screen.getByTestId("feedback-composer-attachment")).toHaveAttribute("data-status", "error"));
    expect(titleInput()).toHaveValue("t");
    expect(openPanel).not.toHaveBeenCalled();
  });

  it("persists finished uploads with the draft so a reopened composer still has them", async () => {
    const { transport, uploads } = makeTransport();
    const first = await renderComposer(transport);
    fireEvent.change(fileInput(), { target: { files: [png()] } });
    await waitFor(() => expect(uploads).toHaveLength(1));
    await act(async () => uploads[0].done.resolve({ url: "https://s.public.blob.vercel-storage.com/keep.png" }));
    first.unmount();

    await renderComposer(transport);
    const chip = screen.getByTestId("feedback-composer-attachment");
    expect(chip).toHaveAttribute("data-status", "done");
    expect(within(chip).getByText("shot.png")).toBeInTheDocument();
  });
});
