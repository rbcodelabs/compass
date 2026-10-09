// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DocsLibraryPane } from "@/components/docs/docs-library-pane";
import { DocsLibraryExpandButton, DocsLibraryProvider } from "@/components/docs/docs-library-context";
import type { DocsLibraryState } from "@/lib/docs-library-pane";
import { DOCS_LIBRARY_COOKIE_NAME } from "@/lib/docs-library-pane";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/org/work/docs" }));
vi.mock("@/app/[orgSlug]/[workspaceSlug]/docs/actions", () => ({ createDoc: vi.fn(), createCanvasDoc: vi.fn() }));

function clearCookie() {
  document.cookie = `${DOCS_LIBRARY_COOKIE_NAME}=; Path=/; Max-Age=0`;
}
afterEach(() => { cleanup(); clearCookie(); vi.restoreAllMocks(); });
beforeEach(() => {
  clearCookie();
  // jsdom has no layout, so clientWidth is 0 and the main-content floor would
  // clamp every grow to the minimum. Pretend the flex row is 1200px wide.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
});

const props = {
  orgSlug: "org", workspaceSlug: "work", workspaceId: "w",
  docs: [{ id: "d", title: "Zulu strategy", icon: null, parentId: null, sortOrder: 0, children: [] }],
  artifacts: [],
};
// The expand button lives in page content (beside the title), outside the pane.
function renderPane(initialState: DocsLibraryState) {
  return render(
    <DocsLibraryProvider initialState={initialState}>
      <DocsLibraryPane {...props} />
      <h1><DocsLibraryExpandButton />Page title</h1>
    </DocsLibraryProvider>,
  );
}
const cookieValue = () =>
  document.cookie.split("; ").find((c) => c.startsWith(`${DOCS_LIBRARY_COOKIE_NAME}=`))?.split("=")[1];

it("renders at the server-provided width, expanded, with no expand button", () => {
  renderPane({ collapsed: false, width: 300 });
  const pane = screen.getByTestId("library-pane");
  expect(pane.style.getPropertyValue("--docs-library-w")).toBe("300px");
  expect(pane).not.toHaveAttribute("data-collapsed");
  expect(screen.queryByTestId("library-expand")).not.toBeInTheDocument();
  expect(screen.getByRole("separator", { name: "Resize library" })).toHaveAttribute("aria-valuenow", "300");
});

it("collapses away entirely, leaving an expand button beside the title, persists it, and restores the previous width on expand", () => {
  renderPane({ collapsed: false, width: 300 });
  fireEvent.click(screen.getByRole("button", { name: "Collapse library" }));
  expect(screen.getByTestId("library-expand")).toBeInTheDocument();
  expect(screen.getByTestId("library-pane")).toHaveAttribute("data-collapsed");
  expect(cookieValue()).toBe("1:300");

  fireEvent.click(screen.getByRole("button", { name: "Expand library" }));
  expect(screen.queryByTestId("library-expand")).not.toBeInTheDocument();
  expect(screen.getByTestId("library-pane")).not.toHaveAttribute("data-collapsed");
  expect(screen.getByTestId("library-pane").style.getPropertyValue("--docs-library-w")).toBe("300px");
  expect(cookieValue()).toBe("0:300");
});

it("starts collapsed when the cookie says so", () => {
  renderPane({ collapsed: true, width: 260 });
  expect(screen.getByTestId("library-expand")).toBeInTheDocument();
  expect(screen.getByTestId("library-pane")).toHaveAttribute("data-collapsed");
});

it("keeps search text through a collapse/expand round trip", () => {
  renderPane({ collapsed: false, width: 240 });
  fireEvent.change(screen.getByRole("textbox", { name: "Find in library" }), { target: { value: "zulu" } });
  fireEvent.click(screen.getByRole("button", { name: "Collapse library" }));
  fireEvent.click(screen.getByRole("button", { name: "Expand library" }));
  expect(screen.getByRole("textbox", { name: "Find in library" })).toHaveValue("zulu");
});

it("resizes from the keyboard, clamps at the bounds, and persists each step", () => {
  renderPane({ collapsed: false, width: 240 });
  const handle = screen.getByRole("separator", { name: "Resize library" });

  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle).toHaveAttribute("aria-valuenow", "256");
  expect(cookieValue()).toBe("0:256");

  fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
  // 256 - 64 = 192, below the 200 minimum.
  expect(handle).toHaveAttribute("aria-valuenow", "200");

  fireEvent.keyDown(handle, { key: "End" });
  // 1200px container - 480px main floor = 720, capped at the 480 maximum.
  expect(handle).toHaveAttribute("aria-valuenow", "480");

  fireEvent.keyDown(handle, { key: "Home" });
  expect(handle).toHaveAttribute("aria-valuenow", "200");
});

it("double-click resets to the default width", () => {
  renderPane({ collapsed: false, width: 400 });
  const handle = screen.getByRole("separator", { name: "Resize library" });
  fireEvent.doubleClick(handle);
  expect(handle).toHaveAttribute("aria-valuenow", "240");
  expect(cookieValue()).toBe("0:240");
});
