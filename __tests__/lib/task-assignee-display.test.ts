import { describe, expect, it } from "vitest";

import {
  UNASSIGNED_ASSIGNEE_FILTER,
  UNASSIGNED_ASSIGNEE_LABEL,
  canonicalAssigneeFilterValue,
  taskAssigneeDisplay,
} from "@/lib/task-assignee-display";
import type { MemberData } from "@/lib/types";

const members: MemberData[] = [
  { id: "m1", userId: "user-1", email: "rick@rbcodelabs.com", name: "Rick", role: "ADMIN" },
];

function row(overrides: Partial<Parameters<typeof taskAssigneeDisplay>[0]> = {}) {
  return { assigneeUserId: null, assigneeAgentId: null, assignee: null, ownerName: null, ...overrides };
}

describe("taskAssigneeDisplay", () => {
  it("labels a genuinely empty assignee slot Unassigned and flags it as unassigned", () => {
    expect(taskAssigneeDisplay(row(), members)).toEqual({ label: UNASSIGNED_ASSIGNEE_LABEL, assigned: false });
  });

  it("treats a freeform owner name as assigned, not unassigned", () => {
    expect(taskAssigneeDisplay(row({ ownerName: "Rick" }), members)).toEqual({ label: "Rick", assigned: true });
  });

  it("treats an empty-string owner name as unassigned", () => {
    expect(taskAssigneeDisplay(row({ ownerName: "" }), members)).toEqual({
      label: UNASSIGNED_ASSIGNEE_LABEL,
      assigned: false,
    });
  });

  it("prefers the server-resolved assignee, prefixing agents and marking unavailability", () => {
    expect(
      taskAssigneeDisplay(
        row({ assigneeAgentId: "a1", assignee: { type: "AGENT", id: "a1", displayName: "Engineer", available: false } }),
        members
      )
    ).toEqual({ label: "Agent: Engineer (unavailable)", assigned: true });

    expect(
      taskAssigneeDisplay(
        row({ assigneeUserId: "user-1", assignee: { type: "USER", id: "user-1", displayName: "Rick", available: true } }),
        members
      )
    ).toEqual({ label: "Rick", assigned: true });
  });

  it("falls back to the workspace member when the server did not resolve the assignee", () => {
    expect(taskAssigneeDisplay(row({ assigneeUserId: "user-1" }), members)).toEqual({
      label: "Rick",
      assigned: true,
    });
  });

  it("never reports an orphaned assignee as Unassigned", () => {
    // assigneeUserId points at somebody who is no longer a workspace member and
    // there is no ownerName to fall back to. Showing "Unassigned" here would
    // misrepresent a task that genuinely has an assignee on record.
    const orphan = taskAssigneeDisplay(row({ assigneeUserId: "departed" }), members);
    expect(orphan).toEqual({ label: "Unavailable assignee", assigned: true });

    const orphanAgent = taskAssigneeDisplay(row({ assigneeAgentId: "gone" }), members);
    expect(orphanAgent).toEqual({ label: "Unavailable assignee", assigned: true });
  });
});

describe("canonicalAssigneeFilterValue", () => {
  it("normalizes a legacy bare user id to its prefixed form", () => {
    expect(canonicalAssigneeFilterValue("user-1")).toBe("user:user-1");
  });

  it("leaves already-typed values untouched", () => {
    expect(canonicalAssigneeFilterValue("user:user-1")).toBe("user:user-1");
    expect(canonicalAssigneeFilterValue("agent:a1")).toBe("agent:a1");
  });

  it("passes the unassigned sentinel through without turning it into a user id", () => {
    expect(canonicalAssigneeFilterValue(UNASSIGNED_ASSIGNEE_FILTER)).toBe(UNASSIGNED_ASSIGNEE_FILTER);
  });

  it("maps absent values to null", () => {
    expect(canonicalAssigneeFilterValue(null)).toBeNull();
    expect(canonicalAssigneeFilterValue(undefined)).toBeNull();
    expect(canonicalAssigneeFilterValue("")).toBeNull();
  });

  it("uses a sentinel that cannot collide with a uuid assignee id", () => {
    // assigneeUserId / assigneeAgentId are @db.Uuid, so a value containing
    // underscores can never be mistaken for a real id.
    expect(UNASSIGNED_ASSIGNEE_FILTER).toMatch(/_/);
    expect(UNASSIGNED_ASSIGNEE_FILTER).not.toMatch(/^[0-9a-f-]+$/i);
  });
});
