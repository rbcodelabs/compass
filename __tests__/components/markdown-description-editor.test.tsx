// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { MarkdownDescriptionEditor } from "@/components/markdown-description-editor";

afterEach(cleanup);

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <MarkdownDescriptionEditor value={value} onChange={setValue} label="Description" />;
}

describe("MarkdownDescriptionEditor", () => {
  it("initializes rich content and switches to its Markdown", async () => {
    render(<Harness initial={"## Goal\n\nA **bold** idea."} />);
    expect(screen.getByRole("textbox").innerHTML).toBe("<h2>Goal</h2><p>A <strong>bold</strong> idea.</p>");
    expect(await screen.findByRole("heading", { name: "Goal" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    expect(screen.getByRole("textbox")).toHaveValue("## Goal\n\nA **bold** idea.");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "### Changed\n\nNew *idea*." } });
    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    expect(screen.getByRole("heading", { name: "Changed", level: 3 })).toBeVisible();
  });

  it.each([
    ["HTML", "Before <em>literal</em> after"],
    ["images", "![private](https://example.com/private.png)"],
    ["images", "![private][asset]\n\n[asset]: https://example.com/private.png"],
    ["task lists", "- [x] Done\n- [ ] Next"],
    ["footnotes", "Text[^1]\n\n[^1]: Note"],
    ["code metadata", "```js title=example\nconst a = 1\n```"],
  ])("preserves %s byte for byte in source mode", (_reason, source) => {
    const onChange = vi.fn();
    render(<MarkdownDescriptionEditor value={source} onChange={onChange} label="Description" />);
    expect(screen.getByRole("textbox")).toHaveValue(source);
    expect(screen.getByRole("button", { name: "Rich" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent(_reason);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not mistake fenced or escaped image/HTML examples for unsupported content", () => {
    render(<Harness initial={'```md\n![x](url) <div>\n```\n\n\\![example](https://example.com)'} />);
    expect(screen.getByRole("button", { name: "Rich" })).toBeEnabled();
  });

  it("re-enables rich mode after source-only constructs are removed", () => {
    render(<Harness initial="![private](https://example.com/image.png)" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "## Safe" } });
    fireEvent.click(screen.getByRole("button", { name: "Rich" }));
    expect(screen.getByRole("heading", { name: "Safe" })).toBeVisible();
  });

  it("updates when an externally controlled value is reset", () => {
    const props = { onChange: vi.fn(), label: "Description" };
    const { rerender } = render(<MarkdownDescriptionEditor {...props} value="## First" />);
    rerender(<MarkdownDescriptionEditor {...props} value="## Second" />);
    expect(screen.getByRole("heading", { name: "Second" })).toBeVisible();
    expect(screen.queryByText("First")).toBeNull();
  });

  it("does not add inner Save/Cancel controls when a dialog owns the transaction", () => {
    render(<Harness initial="Example" />);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("routes the save shortcut through the owning form", () => {
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(<form onSubmit={submit}><Harness initial="Example" /><button type="submit">Save changes</button></form>);
    fireEvent.click(screen.getByRole("button", { name: "Markdown" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(submit).toHaveBeenCalledOnce();
  });
});
