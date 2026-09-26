// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import { afterEach, describe, expect, it } from "vitest"
import { ConsentForm } from "@/app/oauth/authorize/consent-form"

const options = {
  agentsEnabled: true,
  agents: [],
  grantable: [
    { id: "workspace-a", name: "Compass", slug: "compass", organizationId: "org", organizationName: "RB Code Labs", organizationSlug: "rbcodelabs" },
    { id: "workspace-b", name: "Personal", slug: "personal", organizationId: "org", organizationName: "RB Code Labs", organizationSlug: "rbcodelabs" },
  ],
  overrideAvailable: true,
  unresolvedMemberships: 0,
}

function form() {
  return render(
    <ConsentForm
      signedRequest="signed"
      details={<p>Details</p>}
      overrideReach={<p>All workspaces</p>}
      options={options}
      inlineAccess="WRITE"
      userEmail="rick@example.com"
    />,
  )
}

afterEach(cleanup)

describe("OAuth consent checkboxes", () => {
  it("uses the Checkbox primitive and preserves checked workspace form values", () => {
    form()
    const compass = screen.getByRole("checkbox", { name: /Compass/ })
    const personal = screen.getByRole("checkbox", { name: /Personal/ })

    expect(compass).toHaveAttribute("data-slot", "checkbox")
    expect(personal).toBeChecked()
    fireEvent.click(personal)

    const allow = document.querySelector<HTMLFormElement>("#oauth-consent-allow")!
    expect(new FormData(allow).getAll("grantWorkspaceId")).toEqual(["workspace-a"])
  })

  it("uses the Checkbox primitive for full-account acknowledgement and disables grants", () => {
    form()
    fireEvent.click(screen.getByText("Authorize as yourself instead"))
    const acknowledgement = screen.getByRole("checkbox", { name: /I understand this grants my full account access/ })
    fireEvent.click(acknowledgement)

    expect(acknowledgement).toHaveAttribute("data-slot", "checkbox")
    expect(acknowledgement).toBeChecked()
    expect(screen.getByRole("checkbox", { name: /Compass/ })).toHaveAttribute("aria-disabled", "true")
  })
})
