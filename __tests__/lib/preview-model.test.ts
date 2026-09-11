import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
it("persists automation identity on sessions and exact run ownership", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  expect(schema).toContain("model PreviewAutomationSession");
  expect(schema).toContain("model PreviewAutomationRun");
  expect(schema).toContain("isolatedWorkspaceId");
  expect(schema).toContain("model PreviewAutomationNonce");
});
