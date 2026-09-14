// @vitest-environment jsdom
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Base UI's `<Select.Value>` renders the *raw value* unless `Select.Root` gets
 * an `items` map, while every call site here is written in Radix idiom. These
 * tests pin the closed-trigger label — deliberately never opening the popup,
 * because that was exactly the state where the raw enum leaked through.
 */
function triggerText(): string {
  return screen.getByRole("combobox").textContent ?? "";
}

describe("Select trigger label resolution", () => {
  afterEach(() => cleanup());

  it("renders the item's label on the closed trigger, not the raw value", () => {
    render(
      <Select value="ADMIN">
        <SelectTrigger aria-label="Role">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ADMIN">Admin</SelectItem>
          <SelectItem value="READ">Read only</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(triggerText()).toContain("Admin");
    expect(triggerText()).not.toContain("ADMIN");
  });

  it("finds items nested inside groups and mapped arrays", () => {
    const options = [
      { value: "IN_PROGRESS", label: "In progress" },
      { value: "DONE", label: "Done" },
    ];

    render(
      <Select value="IN_PROGRESS">
        <SelectTrigger aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    );

    expect(triggerText()).toContain("In progress");
    expect(triggerText()).not.toContain("IN_PROGRESS");
  });

  it("lets an explicitly passed items prop win over the derived one", () => {
    render(
      <Select value="ADMIN" items={{ ADMIN: "Administrator" }}>
        <SelectTrigger aria-label="Role">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ADMIN">Admin</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(triggerText()).toContain("Administrator");
  });

  it("still lets the <SelectValue>{fn}</SelectValue> formatter take precedence", () => {
    render(
      <Select value="USER:abc-123">
        <SelectTrigger aria-label="Assignee">
          <SelectValue>
            {(value: string | null) =>
              value === "USER:abc-123" ? "Rick Bowman" : "Unassigned"
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="USER:abc-123">Rick B.</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(triggerText()).toContain("Rick Bowman");
    expect(triggerText()).not.toContain("abc-123");
  });

  it("leaves the placeholder alone when nothing is selected", () => {
    render(
      <Select value={null}>
        <SelectTrigger aria-label="Role">
          <SelectValue placeholder="Pick a role…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ADMIN">Admin</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(triggerText()).toContain("Pick a role…");
  });

  it("joins a label split across several text children", () => {
    render(
      <Select value="agent-1">
        <SelectTrigger aria-label="Assignee">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="agent-1">{"Engineer"}{" (agent)"}</SelectItem>
        </SelectContent>
      </Select>
    );

    expect(triggerText()).toContain("Engineer (agent)");
  });

  it("leaves a rich (non-text) label to the caller rather than guessing", () => {
    render(
      <Select value="BUG">
        <SelectTrigger aria-label="Type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="BUG">
            <span data-testid="icon" />
            Bug
          </SelectItem>
        </SelectContent>
      </Select>
    );

    // No safe text to derive, so Base UI's default (raw value) still applies —
    // such call sites pass `items` or a <SelectValue> formatter explicitly.
    expect(triggerText()).toContain("BUG");
  });

  it("does not re-render in a loop when the derived items map is rebuilt", () => {
    let renders = 0;

    function Harness() {
      renders += 1;
      const [, force] = React.useState(0);
      React.useEffect(() => {
        // One external update; a loop would keep this climbing past the guard.
        force(1);
      }, []);
      return (
        <Select value="URGENT">
          <SelectTrigger aria-label="Priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="URGENT">Urgent</SelectItem>
            <SelectItem value="LOW">Low</SelectItem>
          </SelectContent>
        </Select>
      );
    }

    render(<Harness />);

    expect(triggerText()).toContain("Urgent");
    expect(renders).toBeLessThanOrEqual(3);
  });
});
