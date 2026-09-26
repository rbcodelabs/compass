import { describe, expect, it, vi } from "vitest";
const findFirst = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({ default: () => ({ doc: { findFirst } }) }));
import { validateTaskLink } from "@/lib/task-assignment";

describe("document task reference validation", () => {
  it("checks ownership without reading document content or private storage references", async () => {
    findFirst.mockResolvedValueOnce({ id: "doc-a" });
    await validateTaskLink("workspace-a", "DOC", "doc-a");
    expect(findFirst).toHaveBeenCalledWith({ where: { id: "doc-a", workspaceId: "workspace-a" }, select: { id: true } });
  });
});
