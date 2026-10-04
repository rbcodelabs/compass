// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { HelpContentFrame } from "@/components/help-content-frame";
let pathname = "/help/09-rest-api";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
afterEach(cleanup);
it("preserves the article sidebar", () => {
  render(
    <HelpContentFrame navigation={<p>Guide navigation</p>}>
      <p>Article</p>
    </HelpContentFrame>,
  );
  expect(screen.getByText("Guide navigation")).toBeInTheDocument();
});
it("gives only the explorer a full-width single navigation frame", () => {
  pathname = "/help/api-explorer";
  render(
    <HelpContentFrame navigation={<p>Guide navigation</p>}>
      <p>Explorer</p>
    </HelpContentFrame>,
  );
  expect(screen.queryByText("Guide navigation")).not.toBeInTheDocument();
  expect(screen.getByRole("main")).toHaveClass("min-w-0");
  expect(
    screen.getByRole("navigation", { name: "Developer navigation" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Guide" })).toHaveAttribute(
    "href",
    "/help/09-rest-api",
  );
});
