// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import "@testing-library/jest-dom/vitest";

import { Section } from "@/components/panels/panel-parts";
import {
  PANEL_SECTION_COOKIE_NAME,
  panelSectionStateKey,
  parsePanelSectionState,
  serializePanelSectionState,
} from "@/lib/panel-section-state";

function readStateCookie(): Record<string, boolean> {
  const raw = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${PANEL_SECTION_COOKIE_NAME}=`))
    ?.slice(PANEL_SECTION_COOKIE_NAME.length + 1);
  return parsePanelSectionState(raw);
}

function seedStateCookie(state: Record<string, boolean>) {
  document.cookie = `${PANEL_SECTION_COOKIE_NAME}=${serializePanelSectionState(state)}; path=/`;
}

describe("Section disclosure", () => {
  beforeEach(() => {
    document.cookie = `${PANEL_SECTION_COOKIE_NAME}=; path=/; max-age=0`;
  });

  afterEach(() => {
    cleanup();
  });

  it("leaves a non-collapsible Section fully expanded with no trigger", () => {
    render(
      <Section label="Evidence" count={2}>
        <p>section body</p>
      </Section>
    );

    expect(screen.getByText("section body")).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Evidence/).tagName).toBe("P");
  });

  it("emits unchanged markup for a non-collapsible Section", () => {
    // Byte-for-byte the markup this component produced before the disclosure
    // existed, so the panels that never opted in (Objective, Key Result,
    // Assumption, Experiment, Feedback) cannot drift. Only Section's own
    // wrapper is asserted — the Separator's internals are not its contract.
    const html = renderToString(
      <Section label="Evidence" count={3}>
        <p>body</p>
      </Section>
    );

    expect(html).toContain(
      '<div class="flex flex-col gap-2">' +
        '<p class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">' +
        'Evidence<span class="normal-case font-normal"> (<!-- -->3<!-- -->)</span></p>' +
        "<p>body</p></div>"
    );
  });

  it("folds and unfolds a collapsible Section, toggling aria-expanded", () => {
    render(
      <Section label="Evidence" count={2} collapsible panelType="solution" defaultOpen>
        <p>section body</p>
      </Section>
    );

    const trigger = screen.getByRole("button", { name: /Evidence/ });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("section body")).toBeVisible();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("section body")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("section body")).toBeVisible();
  });

  it("keeps the count visible while the Section is collapsed", () => {
    render(
      <Section label="Evidence" count={7} collapsible panelType="solution" defaultOpen>
        <p>section body</p>
      </Section>
    );

    const trigger = screen.getByRole("button", { name: /Evidence/ });
    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toBeVisible();
    expect(trigger).toHaveTextContent("(7)");
  });

  it("renders an empty Section collapsed with a disabled trigger", () => {
    render(
      <Section
        label="Linked to"
        count={0}
        collapsible
        panelType="roadmapItem"
        defaultOpen
        empty
      >
        <p>Not linked to any discovery item.</p>
      </Section>
    );

    const trigger = screen.getByRole("button", { name: /Linked to/ });
    // Base UI keeps a disabled disclosure focusable and marks it with
    // aria-disabled rather than the native attribute, so screen-reader users
    // still hear the section exists.
    expect(trigger).toHaveAttribute("aria-disabled", "true");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Not linked to any discovery item.")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Not linked to any discovery item.")).toBeNull();
  });

  it("persists open state across unmount and remount", () => {
    const markup = (
      <Section label="Evidence" count={2} collapsible panelType="solution" defaultOpen>
        <p>section body</p>
      </Section>
    );

    const first = render(markup);
    fireEvent.click(screen.getByRole("button", { name: /Evidence/ }));
    expect(readStateCookie()[panelSectionStateKey("solution", "Evidence")]).toBe(false);
    first.unmount();

    render(markup);
    expect(screen.getByRole("button", { name: /Evidence/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("keys persisted state per panel type so identically named sections stay independent", () => {
    seedStateCookie({ [panelSectionStateKey("solution", "Launch")]: true });

    render(
      <Section label="Launch" collapsible panelType="roadmapItem" defaultOpen={false}>
        <p>roadmap launch body</p>
      </Section>
    );

    expect(screen.getByRole("button", { name: /Launch/ })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("resolves persisted state during render, not in an effect", () => {
    seedStateCookie({ [panelSectionStateKey("solution", "Assumptions")]: false });

    const html = renderToString(
      <Section label="Assumptions" count={3} collapsible panelType="solution" defaultOpen>
        <p>section body</p>
      </Section>
    );

    // Effects never run during renderToString, so a closed disclosure in this
    // markup proves the stored state was read synchronously while rendering —
    // the thing that prevents an open-then-collapse flip after hydration.
    expect(html).toContain('aria-expanded="false"');
  });
});
