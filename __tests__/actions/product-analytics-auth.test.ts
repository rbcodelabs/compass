import { expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ write: vi.fn().mockResolvedValue({ id: "entity", assumptionId: null }), read: vi.fn().mockResolvedValue(null) }));
vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db", () => ({ default: () => Object.fromEntries(["workspace", "opportunity", "solution", "experiment", "experimentResult"].map(name => [name, { create: m.write, update: m.write, findFirst: m.read }])) }));
import * as discovery from "@/app/[orgSlug]/[workspaceSlug]/discovery/actions";
import * as experiments from "@/app/[orgSlug]/[workspaceSlug]/experiments/actions";

it.each([
  ["create opportunity", () => discovery.createOpportunity("ws", { title: "Example" })],
  ["change opportunity status", () => discovery.updateOpportunityStatus("opp", "VALIDATING", "/")],
  ["add solution", () => discovery.addSolution("opp", { title: "Example" }, "/")],
  ["change solution status", () => discovery.updateSolutionStatus("sol", "VALIDATED", "/")],
  ["move opportunity", () => discovery.moveOpportunity("opp", "VALIDATING", "ws", "/")],
  ["move solution", () => discovery.moveSolutionStatus("sol", "VALIDATED", "opp", "ws", "/")],
  ["create experiment", () => experiments.createExperiment("ws", { title: "Example", hypothesis: "Hypothesis", method: "Method", killCondition: "Stop" })],
  ["start experiment", () => experiments.startExperiment("exp")],
  ["record result", () => experiments.logResult("exp", { note: "Example" })],
  ["conclude experiment", () => experiments.concludeExperiment("exp", "PROCEED")],
  ["move experiment", () => experiments.moveExperiment("exp", "RUNNING", "ws", "/")],
] as const)("%s requires auth independently of analytics collection", async (_name, call) => {
  vi.clearAllMocks();
  await expect(call()).rejects.toThrow("Unauthorized");
  expect(m.write).not.toHaveBeenCalled();
});
