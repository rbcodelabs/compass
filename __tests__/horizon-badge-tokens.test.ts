import { describe, expect, it } from "vitest";
import { HORIZON_META } from "@/lib/roadmap";

// The horizon pill must follow the theme (light and dark). Raw palette pairs such as
// `bg-blue-100 text-blue-700` stay light in dark mode and washed out the "Next" pill.
describe("horizon badge classes", () => {
  it.each(Object.entries(HORIZON_META))("%s uses paired status theme tokens, not raw palette colours", (_horizon, meta) => {
    expect(meta.badgeClass).toMatch(/^bg-status-(neutral|info|success|warning|danger)-surface text-status-\1$/);
  });
});
