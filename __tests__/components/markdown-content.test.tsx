// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MarkdownContent } from "@/components/markdown-content";

afterEach(cleanup);

describe("MarkdownContent", () => {
  it("renders paragraphs and GitHub-flavored Markdown", () => {
    render(<MarkdownContent>{"First.\n\n- [x] Done\n\n| A | B |\n|---|---|\n| 1 | 2 |"}</MarkdownContent>);
    expect(screen.getByText("First.").tagName).toBe("P");
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("preserves legacy soft line breaks", () => {
    const { container } = render(<MarkdownContent>{"first line\nsecond line"}</MarkdownContent>);
    expect(container.firstElementChild?.className).toContain("[&_p]:whitespace-pre-line");
  });

  it("does not render raw HTML, unsafe links, or remote images", () => {
    const { container } = render(<MarkdownContent>{'<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![tracker](https://example.com/pixel.gif)'}</MarkdownContent>);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("bad").closest("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("opens external links safely", () => {
    render(<MarkdownContent>{"[Docs](https://example.com)"}</MarkdownContent>);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("treats protocol-relative links as external", () => {
    render(<MarkdownContent>{"[Docs](//example.com/path)"}</MarkdownContent>);
    expect(screen.getByRole("link")).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("lets caller utility classes override defaults", () => {
    const { container } = render(<MarkdownContent className="text-xs">small</MarkdownContent>);
    expect(container.firstElementChild).toHaveClass("text-xs");
    expect(container.firstElementChild).not.toHaveClass("text-sm");
  });
});
