// @vitest-environment jsdom
import * as React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DocCommentsSidebar } from "@/components/docs/doc-comments-sidebar";
import { DocVersionHistoryPanel } from "@/components/docs/doc-version-history-panel";

const { getVersion, restoreVersion } = vi.hoisted(() => ({ getVersion: vi.fn(), restoreVersion: vi.fn() }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ getDocVersionContent: getVersion, restoreDocVersion: restoreVersion }));

const props = { open: true, onOpenChange: vi.fn(), comments: [], orphanedIds: new Set<string>(), onAddReply: vi.fn(), onResolve: vi.fn(), onDelete: vi.fn(), onFocusComment: vi.fn() };
beforeEach(() => {
  props.onOpenChange.mockClear();
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 1200 } as DOMRect);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.cookie = "compass_panel_docsComments=; Path=/; Max-Age=0"; });

it("docks Comments without a modal when its server preference is pinned", () => {
  render(<div><div data-slot="doc-editor-column" /><DocCommentsSidebar {...props} initialPin={{ pinned: true, width: 440 }} /></div>);
  expect(screen.getByRole("complementary", { name: "Comments" })).toBeInTheDocument();
  expect(document.querySelector('[data-slot="sheet-overlay"]')).toBeNull();
});

it("pins from the default overlay and persists the Comments preference", () => {
  render(<div><div data-slot="doc-editor-column" /><DocCommentsSidebar {...props} /></div>);
  fireEvent.click(screen.getByRole("button", { name: "Pin panel" }));
  expect(document.cookie).toContain("compass_panel_docsComments=1:448");
  expect(screen.getByRole("complementary", { name: "Comments" })).toBeInTheDocument();
});

it("suspends on a narrow viewport without changing cookies", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  render(<div><DocCommentsSidebar {...props} initialPin={{ pinned: true, width: 600 }} /></div>);
  expect(screen.getByRole("dialog", { name: "Comments" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Unpin panel" })).toBeNull();
  expect(document.cookie).not.toContain("compass_panel_docsComments");
});

it("suspends when the Docs row cannot fit the 480px editor and 320px panel", () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 799 } as DOMRect);
  render(<div><DocCommentsSidebar {...props} initialPin={{ pinned: true, width: 720 }} /></div>);
  expect(screen.getByRole("dialog", { name: "Comments" })).toBeInTheDocument();
  expect(document.cookie).not.toContain("compass_panel_docsComments");
});

it("constrains a stored maximum width before any drag without overwriting preference", () => {
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ width: 1000 } as DOMRect);
  render(<div><DocCommentsSidebar {...props} initialPin={{ pinned: true, width: 720 }} /></div>);
  expect(screen.getByRole("complementary")).toHaveStyle({ "--panel-w": "520px" });
  expect(document.cookie).not.toContain("compass_panel_docsComments");
});

it("keyboard resizing uses the editor column and preserves the other panel cookie", () => {
  document.cookie = "compass_panel_docsHistory=1:600; Path=/";
  render(<div><div data-slot="doc-editor-column" data-testid="column" /><DocCommentsSidebar {...props} initialPin={{ pinned: true, width: 448 }} /></div>);
  screen.getByTestId("column").getBoundingClientRect = () => ({ width: 600 } as DOMRect);
  screen.getByRole("complementary").getBoundingClientRect = () => ({ width: 448 } as DOMRect);
  fireEvent.keyDown(screen.getByRole("separator"), { key: "End" });
  expect(document.cookie).toContain("compass_panel_docsComments=1:568");
  expect(document.cookie).toContain("compass_panel_docsHistory=1:600");
  document.cookie = "compass_panel_docsHistory=; Path=/; Max-Age=0";
});

it("Escape only closes from within the pinned panel", () => {
  render(<div><input aria-label="Editor" /><DocCommentsSidebar {...props} initialPin={{ pinned: true, width: 448 }} /></div>);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(props.onOpenChange).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByTestId("doc-comments-list"), { key: "Escape" });
  expect(props.onOpenChange).toHaveBeenCalledWith(false);
});

it("retains Show resolved across closing and reopening", () => {
  const resolved = [{ id: "c", parentId: null, body: "resolved body", status: "RESOLVED", anchorText: null, anchorStart: null, anchorEnd: null, anchorPrefix: null, anchorSuffix: null, authorName: "Test", authorType: "HUMAN", createdAt: new Date() }];
  const view = (open: boolean) => <div><DocCommentsSidebar {...props} open={open} comments={resolved} initialPin={{ pinned: true, width: 448 }} /></div>;
  const { rerender } = render(view(true));
  fireEvent.click(screen.getByRole("button", { name: "Show resolved (1)" }));
  rerender(view(false));
  rerender(view(true));
  expect(screen.getByText("resolved body")).toBeVisible();
});

it.each([true, false])("restoring History with pinned=%s uses the correct close behavior", async (pinned) => {
  const version = { id: "v", title: "Earlier", content: "previous", createdAt: new Date(), label: "Snapshot", createdByName: "Test" };
  getVersion.mockResolvedValue(version);
  restoreVersion.mockResolvedValue({ title: "Earlier" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const close = vi.fn();
  const restored = vi.fn();
  render(<div><DocVersionHistoryPanel open onOpenChange={close} initialPin={{ pinned, width: 448 }} currentTitle="Current" currentContent="new" versions={[version]} revalidatePathStr="/test" onRestored={restored} /></div>);
  fireEvent.click(screen.getByRole("button", { name: /Snapshot/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
  await screen.findByText("Current version");
  expect(restored).toHaveBeenCalledWith("previous", "Earlier");
  if (pinned) expect(close).not.toHaveBeenCalled();
  else expect(close).toHaveBeenCalledWith(false);
});
