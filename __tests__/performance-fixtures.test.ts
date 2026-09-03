import { describe, expect, it } from "vitest";
import { ROUTES } from "../e2e/performance/fixtures";

describe("performance navigation fixtures", () => {
  it("tracks the authenticated sidebar destinations", () => {
    expect(ROUTES).toEqual(["discovery", "roadmap", "capture", "tasks"]);
  });
});
