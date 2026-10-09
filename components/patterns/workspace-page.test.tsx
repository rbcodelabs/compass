// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { WorkspacePage } from "./workspace-page";

afterEach(cleanup);

describe("WorkspacePage", () => {
  it("renders title, actions, controls and content in their slots", () => {
    const { container } = render(
      <WorkspacePage title="Tasks" actions={<button>Act</button>} controls={<button>Ctl</button>}>
        <p>Body</p>
      </WorkspacePage>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="workspace-header-actions"]')).toContainElement(screen.getByText("Act"));
    expect(container.querySelector('[data-slot="workspace-header-controls"]')).toContainElement(screen.getByText("Ctl"));
    expect(container.querySelector('[data-slot="workspace-content"]')).toContainElement(screen.getByText("Body"));
  });

  it("omits the controls and actions wrappers when not provided", () => {
    const { container } = render(<WorkspacePage title="Tasks"><p>Body</p></WorkspacePage>);
    expect(container.querySelector('[data-slot="workspace-header-controls"]')).toBeNull();
    expect(container.querySelector('[data-slot="workspace-header-actions"]')).toBeNull();
    expect(container.querySelector('[data-slot="workspace-toolbar"]')).toBeNull();
  });

  it("marks the toolbar so an empty portal host hides the bar", () => {
    const { container } = render(
      <WorkspacePage title="Feedback" toolbar={<div data-toolbar-host id="host" />}>
        <p>Body</p>
      </WorkspacePage>,
    );
    const toolbar = container.querySelector('[data-slot="workspace-toolbar"]');
    expect(toolbar).toContainElement(container.querySelector("#host") as HTMLElement);
    // jsdom cannot evaluate :has(); assert the rule that does the hiding is present.
    expect(toolbar?.className).toContain("has-[[data-toolbar-host]:empty]:hidden");
  });
});
