// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setLaunchTier: vi.fn(),
  notifyEntityMutated: vi.fn(),
}));

vi.mock("@/app/[orgSlug]/[workspaceSlug]/roadmap/launch-actions", () => ({
  setLaunchTier: mocks.setLaunchTier,
}));
vi.mock("@/components/panels/panel-context", () => ({
  usePanelContext: () => ({ notifyEntityMutated: mocks.notifyEntityMutated }),
}));

import { LaunchTierPicker } from "@/components/panels/launch-tier-picker";

describe("LaunchTierPicker authoritative placement notification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("notifies the horizon and revision from the same returned server row", async () => {
    mocks.setLaunchTier.mockResolvedValue({
      id: "item-1",
      horizon: "LAUNCHED",
      updatedAt: "2026-09-05T13:00:00.000Z",
    });
    render(
      <LaunchTierPicker
        itemId="item-1"
        workspaceId="workspace-1"
        revalidatePathStr="/roadmap"
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Set launch tier: Major Launch/ }));

    await waitFor(() => expect(mocks.notifyEntityMutated).toHaveBeenCalledWith("roadmapItem", "item-1", {
      horizon: "LAUNCHED",
      updatedAt: "2026-09-05T13:00:00.000Z",
    }));
  });
});
