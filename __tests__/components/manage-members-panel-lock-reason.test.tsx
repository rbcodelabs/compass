// @vitest-environment jsdom
/**
 * The members panel disables the role dropdown and the remove button whenever
 * acting on the row would leave the workspace without an admin (or without any
 * member at all). Those guards are correct, but a bare disabled control is
 * indistinguishable from a broken one: the sole admin of a workspace sees a
 * greyed-out "Admin" dropdown and no reason for it.
 *
 * These tests pin the explanation to the guard, so the two cannot drift apart.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageMembersPanel } from "@/components/settings/manage-members-panel";
import type { MemberData } from "@/lib/types";

// The panel imports server actions directly; stub them so the module graph does
// not drag a database client into jsdom. No test here invokes them.
vi.mock("@/app/[orgSlug]/[workspaceSlug]/settings/actions", () => ({
  addWorkspaceMember: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  updateWorkspaceMemberRole: vi.fn(),
}));

function member(overrides: Partial<MemberData> & { id: string }): MemberData {
  return {
    name: null,
    email: `${overrides.id}@example.com`,
    role: "MEMBER",
    ...overrides,
  } as MemberData;
}

function renderPanel(members: MemberData[]) {
  return render(
    <ManageMembersPanel
      orgSlug="rbcodelabs"
      workspaceSlug="helios"
      initialMembers={members}
      currentUserMembershipId={members[0]?.id ?? null}
    />,
  );
}

const LAST_ADMIN_REASON = /only admin/i;

// This project has no global RTL setup file, so mounted trees would otherwise
// accumulate in document.body and leak one test's copy of the text into the
// next test's queries.
afterEach(cleanup);

describe("ManageMembersPanel last-admin explanation", () => {
  it("explains why the control is locked for a workspace with a single admin", () => {
    // The exact shape of Rick's Helios workspace: one member, who is the admin.
    renderPanel([member({ id: "m1", role: "ADMIN" })]);

    expect(screen.getByText(LAST_ADMIN_REASON)).toBeTruthy();
  });

  it("wires the explanation to both disabled controls via aria-describedby", () => {
    renderPanel([member({ id: "m1", role: "ADMIN" })]);

    const reasonId = screen.getByText(LAST_ADMIN_REASON).getAttribute("id");
    expect(reasonId).toBeTruthy();

    const remove = screen.getByLabelText(/^Remove /);
    expect(remove.getAttribute("aria-describedby")).toBe(reasonId);
    expect((remove as HTMLButtonElement).disabled).toBe(true);
  });

  it("stays silent when another admin exists, because nothing is locked", () => {
    renderPanel([
      member({ id: "m1", role: "ADMIN" }),
      member({ id: "m2", role: "ADMIN" }),
    ]);

    expect(screen.queryByText(LAST_ADMIN_REASON)).toBeNull();
    expect(screen.queryByText(/at least one member/i)).toBeNull();
  });

  it("falls back to the last-member reason when the only member is not an admin", () => {
    // A lone MEMBER trips isOnlyMember but not isLastAdmin, so the removal
    // guard still fires and needs its own, different explanation.
    renderPanel([member({ id: "m1", role: "MEMBER" })]);

    expect(screen.getByText(/at least one member/i)).toBeTruthy();
    expect(screen.queryByText(LAST_ADMIN_REASON)).toBeNull();
  });
});
