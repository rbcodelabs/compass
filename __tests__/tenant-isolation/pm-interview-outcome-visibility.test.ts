import { describe, expect, it } from "vitest";
import { outcomeOf } from "@/lib/pm-interview-service";

describe("PM interview context: the outcome comes only from an objective in the same workspace", () => {
  const kr = (workspaceId: string | null) => ({ id: "kr-1", title: "Activation", objective: { title: "Grow", workspaceId } });

  it("labels the outcome for a consistent objective", () => {
    expect(outcomeOf(kr("ws-a"), "ws-a")).toEqual({ id: "kr-1", title: "Grow: Activation" });
  });
  it("omits it for a NULL-workspace objective", () => {
    expect(outcomeOf(kr(null), "ws-a")).toBeNull();
  });
  it("omits it for an objective in another workspace", () => {
    expect(outcomeOf(kr("ws-b"), "ws-a")).toBeNull();
  });
  it("omits it when there is no linked key result", () => {
    expect(outcomeOf(null, "ws-a")).toBeNull();
    expect(outcomeOf(undefined, "ws-a")).toBeNull();
  });
});
