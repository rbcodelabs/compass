// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
vi.mock("@/components/api-explorer/api-explorer", () => ({
  ApiExplorer: () => <p>Custom explorer</p>,
}));
import Page, { metadata } from "@/app/help/api-explorer/page";
it("serves the public custom explorer with developer metadata", () => {
  render(<Page />);
  expect(screen.getByText("Custom explorer")).toBeInTheDocument();
  expect(metadata.title).toContain("API Explorer");
});
