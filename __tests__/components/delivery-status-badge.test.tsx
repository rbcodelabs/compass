// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeliveryStatusBadge } from "@/components/roadmap/delivery-status-badge";

describe("DeliveryStatusBadge", () => {
  it("renders visible text with an explicit accessible delivery-status name", () => {
    render(<DeliveryStatusBadge status="IN_DEVELOPMENT" />);

    expect(screen.getByText("In Development").getAttribute("aria-label")).toBe(
      "Delivery status: In Development",
    );
  });
});
