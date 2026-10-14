// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocTreeSidebar } from "@/components/docs/doc-tree-sidebar";
import { createDoc, createCanvasDoc } from "@/app/[orgSlug]/[workspaceSlug]/docs/actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/org/work/docs/artifacts/a" }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ createDoc: vi.fn(), createCanvasDoc: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
const child = { id: "c", title: "Journey diagram", icon: null, parentId: "d", sortOrder: 0, docType: "CANVAS", children: [] };
const props = {
  orgSlug: "org", workspaceSlug: "work", workspaceId: "w",
  docs: [{ id: "d", title: "Zulu strategy", icon: null, parentId: null, sortOrder: 0, children: [child] }],
  artifacts: [{ id: "a", title: "Alpha prototype", sourceType: "EXTERNAL_LINK" }],
};
it("mixes artifacts and document roots alphabetically in one library", () => {
  render(<DocTreeSidebar {...props} />);
  const nav = screen.getByRole("navigation", { name: "Library" });
  expect(within(nav).getAllByRole("link").map(link => link.textContent)).toEqual(["Alpha prototype", "Zulu strategy", "Journey diagram"]);
  expect(screen.getByRole("link", { name: /Alpha prototype/ })).toHaveAttribute("aria-current", "page");
});
it("shows matching descendants with parent context when filtering diagrams", () => {
  render(<DocTreeSidebar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Diagrams" }));
  expect(screen.getByRole("link", { name: "Journey diagram" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Zulu strategy" })).toBeVisible();
  expect(screen.queryByRole("link", { name: /Alpha prototype/ })).not.toBeInTheDocument();
});
it("searches across types and restores collapsed matching descendants", () => {
  render(<DocTreeSidebar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Collapse Zulu strategy" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Find in library" }), { target: { value: "journey" } });
  expect(screen.getByRole("link", { name: "Journey diagram" })).toBeVisible();
  fireEvent.change(screen.getByRole("textbox", { name: "Find in library" }), { target: { value: "missing" } });
  expect(screen.getByText("No matching items.")).toBeVisible();
});
it("offers one creation menu for docs, diagrams, imports, and artifacts", async () => {
  render(<DocTreeSidebar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "New doc" })).toBeVisible());
  expect(screen.getByRole("menuitem", { name: "New diagram" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "Import .canvas file" })).toBeVisible();
  expect(screen.getByRole("menuitem", { name: "New artifact" })).toBeVisible();
});
it("filters ordinary docs while excluding canvas descendants", () => {
  render(<DocTreeSidebar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Docs" }));
  expect(screen.getByRole("link", { name: "Zulu strategy" })).toBeVisible();
  expect(screen.queryByRole("link", { name: "Journey diagram" })).not.toBeInTheDocument();
});
it("keeps an empty library actionable", () => {
  render(<DocTreeSidebar {...props} docs={[]} artifacts={[]} />);
  expect(screen.getByText(/No items yet/)).toBeVisible();
  expect(screen.getByRole("button", { name: "New" })).toBeEnabled();
});
it("reuses an operation on retry but changes it when creation type changes", async () => {
  vi.mocked(createDoc).mockRejectedValue(new Error("offline"));
  vi.mocked(createCanvasDoc).mockResolvedValue({ id: "canvas" } as Awaited<ReturnType<typeof createCanvasDoc>>);
  render(<DocTreeSidebar {...props} />);
  async function choose(name: string) {
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "New" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "New" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name })).toBeVisible());
    fireEvent.click(screen.getByRole("menuitem", { name }));
  }
  await choose("New doc");
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not create this page"));
  const first = vi.mocked(createDoc).mock.calls.at(-1)![3];
  await choose("New doc");
  await waitFor(() => expect(vi.mocked(createDoc)).toHaveBeenCalledTimes(2));
  expect(vi.mocked(createDoc).mock.calls.at(-1)![3]).toEqual(first);
  fireEvent.click(screen.getByRole("button", { name: "Artifacts" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Find in library" }), { target: { value: "alpha" } });
  await choose("New diagram");
  await waitFor(() => expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true"));
  expect(screen.getByRole("textbox", { name: "Find in library" })).toHaveValue("");
  expect(vi.mocked(createCanvasDoc).mock.calls.at(-1)![4]).not.toEqual(first);
});
it("reports unreadable imports without starting creation", async () => {
  render(<DocTreeSidebar {...props} />);
  const file = new File(["{}"], "test.canvas");
  Object.defineProperty(file, "text", { value: () => Promise.reject(new Error("read error")) });
  fireEvent.change(screen.getByTestId("import-canvas-input"), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not read this file"));
  expect(createCanvasDoc).not.toHaveBeenCalled();
});
it("disables creation while a server action is pending", async () => {
  let resolve!: (doc: Awaited<ReturnType<typeof createDoc>>) => void;
  vi.mocked(createDoc).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<DocTreeSidebar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "New" }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: "New doc" })).toBeVisible());
  fireEvent.click(screen.getByRole("menuitem", { name: "New doc" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "New" })).toBeDisabled());
  await act(async () => { resolve({ id: "created" } as Awaited<ReturnType<typeof createDoc>>); });
  await waitFor(() => expect(screen.getByRole("button", { name: "New" })).toBeEnabled());
});
