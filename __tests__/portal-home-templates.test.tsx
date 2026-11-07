// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { PortalHomeWidget } from "@/lib/portal-home/schema"
import type { WidgetResolution } from "@/lib/portal-home/data"
import { PORTAL_TEMPLATES, coerceStoredTemplate } from "@/lib/portal-home/templates"
import { hasUnpublishedChanges } from "@/lib/portal-home/schema"
import { splitHubRegions, templateAttrs } from "@/components/portal-home/templates/arrange"
import { PortalHomeBoard } from "@/components/portal-home/board"
import { TemplatePicker } from "@/components/portal-home/templates/template-picker"
import { PortalShell, type PortalShellProps } from "@/components/portal-home/templates/portal-shell"
import { PortalHomeEditor } from "@/components/portal-home/editor"

const pathname = vi.fn(() => "/portal/acme/main")
vi.mock("next/navigation", () => ({
  usePathname: () => pathname(),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
const loadPublishedHome = vi.fn()
const getPortalSession = vi.fn()
vi.mock("@/lib/db", () => ({
  default: () => ({
    workspace: { findFirst: vi.fn(async () => ({ id: "w1", name: "Acme", roadmapPublic: true, feedbackEnabled: false, brandingPaletteId: null, brandingPrimaryHex: null, brandingFontPresetId: null, brandingFontFamily: null, brandingLogoUrl: null })) },
    roadmapItem: { count: vi.fn(async () => 3), aggregate: vi.fn(async () => ({ _max: { updatedAt: new Date("2026-11-05T10:00:00Z") } })) },
    doc: {
      aggregate: vi.fn(async () => ({ _count: { _all: 2 }, _max: { updatedAt: new Date("2026-11-06T10:00:00Z") } })),
      findMany: vi.fn(async () => [
        { id: "d1", title: "Getting started with Acme", content: "x", updatedAt: new Date("2026-11-06T10:00:00Z"), publishedAt: new Date("2026-11-06T10:00:00Z") },
        { id: "d2", title: "API and webhooks guide", content: "y", updatedAt: new Date("2026-11-05T10:00:00Z"), publishedAt: new Date("2026-11-05T10:00:00Z") },
      ]),
    },
  }),
}))
vi.mock("@/lib/portal-auth", () => ({ getPortalSession: () => getPortalSession() }))
vi.mock("@/lib/portal-home/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-home/service")>()),
  loadPublishedHome: (...args: unknown[]) => loadPublishedHome(...args),
}))

afterEach(() => cleanup())

const widget = (id: string, type: PortalHomeWidget["type"], size: "S" | "M" | "L", order: number, config: object = {}): PortalHomeWidget =>
  ({ id, type, size, order, visibility: "everyone", config }) as PortalHomeWidget

const WIDGETS: PortalHomeWidget[] = [
  widget("a", "announcement", "L", 0, { eyebrow: "", headline: "Big news", body: "", primaryCta: null, secondaryCta: null }),
  widget("t", "rich_text", "M", 1, { title: "Notes", body: "Hello" }),
  widget("l", "key_links", "S", 2, { title: "Links", links: [] }),
  widget("d", "docs", "M", 3, { heading: "Docs", maxItems: 4 }),
]
const RESOLVED: Record<string, WidgetResolution> = {
  a: { available: true, data: { type: "announcement" } },
  t: { available: true, data: { type: "rich_text" } },
  l: { available: true, data: { type: "key_links", links: [{ label: "Changelog", href: "https://x.test", external: true, kind: "url" }] } },
  d: { available: true, data: { type: "docs", docs: [{ id: "1", title: "Getting started", excerpt: "", updatedAt: "2026-01-01T00:00:00Z", publishedAt: "2026-01-01T00:00:00Z", href: "/portal/acme/main/docs/1" }] } },
}

describe("template selection and fallback", () => {
  it("coerces unknown, null and legacy values to editorial and keeps valid ones", () => {
    expect(coerceStoredTemplate(null)).toBe("editorial")
    expect(coerceStoredTemplate("masonry")).toBe("editorial")
    for (const template of PORTAL_TEMPLATES) expect(coerceStoredTemplate(template)).toBe(template)
  })

  it("maps each template to its data attributes (bento is the only solid-hero template)", () => {
    expect(templateAttrs("docs_hub")).toEqual({ "data-tpl": "hub", "data-hero": "light" })
    expect(templateAttrs("bento")).toEqual({ "data-tpl": "bento", "data-hero": "solid" })
    expect(templateAttrs("nonsense")).toEqual({ "data-tpl": "editorial", "data-hero": "light" })
  })

  it("splits the hub into a main column (announcement, then docs) and a rail (links, feedback, small widgets)", () => {
    const { main, rail } = splitHubRegions(WIDGETS)
    expect(main.map((w) => w.id)).toEqual(["a", "d", "t"])
    expect(rail.map((w) => w.id)).toEqual(["l"])
    expect(splitHubRegions([widget("x", "docs", "S", 0)]).main).toHaveLength(1)
  })

  it("counts a template change alone as an unpublished change", () => {
    expect(hasUnpublishedChanges(WIDGETS, WIDGETS, { draft: "bento", published: "editorial" })).toBe(true)
    expect(hasUnpublishedChanges(WIDGETS, WIDGETS, { draft: "bento", published: "bento" })).toBe(false)
  })
})

describe("PortalHomeBoard arrangement", () => {
  const board = (template?: string) => render(<PortalHomeBoard widgets={WIDGETS} resolved={RESOLVED} template={template} />).getByTestId("portal-home-board")

  it("editorial is a single column", () => {
    const el = board("editorial")
    expect(el.getAttribute("data-tpl")).toBe("editorial")
    expect(el.className).toContain("grid-cols-1")
    expect(el.className).not.toContain("md:grid-cols-6")
    expect(el.querySelectorAll(":scope > section")).toHaveLength(4)
  })

  it("bento uses the 6-column spans", () => {
    const el = board("bento")
    expect(el.getAttribute("data-hero")).toBe("solid")
    expect(el.className).toContain("md:grid-cols-6")
    expect(el.querySelector('[data-widget-type="announcement"]')?.className).toContain("md:col-span-6")
    expect(el.querySelector('[data-widget-type="rich_text"]')?.className).toContain("md:col-span-3")
  })

  it("shell is two columns with Large spanning both", () => {
    const el = board("shell")
    expect(el.className).toContain("md:grid-cols-2")
    expect(el.querySelector('[data-widget-type="announcement"]')?.className).toContain("md:col-span-2")
  })

  it("docs hub renders main and rail regions and anchors the docs section", () => {
    const el = board("docs_hub")
    const main = el.querySelector('[data-region="main"]')!
    const rail = el.querySelector('[data-region="rail"]')!
    expect(Array.from(main.children).map((c) => c.getAttribute("data-widget-type"))).toEqual(["announcement", "docs", "rich_text"])
    expect(Array.from(rail.children).map((c) => c.getAttribute("data-widget-type"))).toEqual(["key_links"])
    expect(el.querySelector("#docs")?.getAttribute("data-widget-type")).toBe("docs")
  })

  it("falls back to editorial for an unknown template and keeps the legacy board with no template", () => {
    expect(board("masonry").getAttribute("data-tpl")).toBe("editorial")
    cleanup()
    const legacy = board(undefined)
    expect(legacy.hasAttribute("data-tpl")).toBe(false)
    expect(legacy.className).toContain("md:grid-cols-6")
  })

  it("never renders a widget that is unavailable", () => {
    const resolved = { ...RESOLVED, t: { available: false, reason: "off" } as WidgetResolution }
    const { getByTestId } = render(<PortalHomeBoard widgets={WIDGETS} resolved={resolved} template="bento" />)
    expect(getByTestId("portal-home-board").querySelector('[data-widget-type="rich_text"]')).toBeNull()
  })
})

describe("TemplatePicker", () => {
  it("shows four radio cards with label and description and reports a change", () => {
    const onChange = vi.fn()
    render(<TemplatePicker value="editorial" onChange={onChange} />)
    const radios = screen.getAllByRole("radio")
    expect(radios).toHaveLength(4)
    expect((screen.getByRole("radio", { name: /Editorial/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText("A grid of tiles sized by widget, for a dashboard feel.")).toBeTruthy()
    fireEvent.click(screen.getByRole("radio", { name: /Docs hub/ }))
    expect(onChange).toHaveBeenCalledWith("docs_hub")
  })
})

describe("PortalShell", () => {
  const props: Omit<PortalShellProps, "template"> = {
    orgSlug: "acme", workspaceSlug: "main", workspaceName: "Acme", logoUrl: null,
    roadmapPublic: true, feedbackEnabled: false, email: "pat@example.com", showDocs: true,
    children: <p>page body</p>,
  }

  beforeEach(() => pathname.mockReturnValue("/portal/acme/main"))

  it.each([
    ["editorial", "portal-shell-editorial"],
    ["bento", "portal-shell-bento"],
    ["shell", "portal-shell-sidebar"],
    ["docs_hub", "portal-shell-hub"],
  ] as const)("%s renders its own chrome with nav, auth status and the page", (template, testId) => {
    render(<PortalShell {...props} template={template} />)
    expect(screen.getByTestId(testId)).toBeTruthy()
    expect(screen.getByText("page body")).toBeTruthy()
    expect(screen.getByText("pat@example.com")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Home" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Roadmap" })).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Feedback" })).toBeNull()
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/portal/acme/main#docs")
  })

  it("falls back to editorial chrome for an unrecognised template", () => {
    render(<PortalShell {...props} template={"masonry" as never} />)
    expect(screen.getByTestId("portal-shell-editorial")).toBeTruthy()
  })

  it("shows the hero (with its buttons) on the home page only", () => {
    render(<PortalShell {...props} template="editorial" />)
    expect(screen.getByRole("heading", { level: 1, name: "Acme" })).toBeTruthy()
    expect(screen.getByRole("link", { name: /View the roadmap/ })).toBeTruthy()
    cleanup()
    pathname.mockReturnValue("/portal/acme/main/roadmap")
    render(<PortalShell {...props} template="editorial" />)
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull()
  })

  it("editorial hero meta line shows only real figures, in order, and is absent with none", () => {
    render(<PortalShell {...props} template="editorial" heroMeta={{ updatedAt: "2026-11-05T10:00:00Z", inProgress: 6, docs: 1 }} />)
    expect(screen.getByTestId("portal-hero-meta").textContent).toBe("Updated Nov 5, 2026·6 items in progress·1 published doc")
    cleanup()
    render(<PortalShell {...props} template="editorial" heroMeta={{ updatedAt: null, inProgress: null, docs: null }} />)
    expect(screen.queryByTestId("portal-hero-meta")).toBeNull()
    cleanup()
    render(<PortalShell {...props} template="editorial" />)
    expect(screen.queryByTestId("portal-hero-meta")).toBeNull()
  })

  it("hub hero offers Popular chips from the given titles; clicking one filters the docs", () => {
    render(
      <PortalShell {...props} template="docs_hub" searchSuggestions={["API guide"]}>
        <section data-widget-type="docs"><ul><li>Getting started</li><li>API guide</li></ul></section>
      </PortalShell>,
    )
    fireEvent.click(within(screen.getByTestId("hub-popular")).getByRole("button", { name: "API guide" }))
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("API guide")
    expect(screen.getAllByRole("listitem", { hidden: true }).filter((li) => !li.hidden).map((li) => li.textContent)).toEqual(["API guide"])
    cleanup()
    render(<PortalShell {...props} template="docs_hub" />)
    expect(screen.queryByTestId("hub-popular")).toBeNull()
  })

  it("omits Docs from the nav when the home has no docs widget", () => {
    render(<PortalShell {...props} showDocs={false} template="shell" />)
    expect(screen.queryByRole("link", { name: "Docs" })).toBeNull()
  })

  it("hub hero is search-first and filters the docs on the page", () => {
    render(
      <PortalShell {...props} template="docs_hub">
        <section data-widget-type="docs"><ul><li>Getting started</li><li>API guide</li></ul></section>
      </PortalShell>,
    )
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "api" } })
    const items = screen.getAllByRole("listitem", { hidden: true })
    expect(items.filter((li) => !li.hidden).map((li) => li.textContent)).toEqual(["API guide"])
    expect(screen.getByRole("status").textContent).toBe("1 doc matches.")
  })

  it("the shell sidebar opens as a drawer from the menu button", () => {
    render(<PortalShell {...props} template="shell" />)
    const toggle = screen.getByRole("button", { name: "Open menu" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(within(screen.getByRole("complementary", { hidden: true })).getByRole("link", { name: "Roadmap", hidden: true }))
    expect(screen.getByRole("button", { name: "Open menu" }).getAttribute("aria-expanded")).toBe("false")
  })
})

describe("portal layout", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  afterEach(() => vi.unstubAllGlobals())

  async function renderLayout(published: { widgets: PortalHomeWidget[] | null; template: string }) {
    loadPublishedHome.mockResolvedValue(published)
    getPortalSession.mockResolvedValue(null)
    const { default: PortalLayout } = await import("@/app/portal/[orgSlug]/[workspaceSlug]/layout")
    const element = await PortalLayout({ children: <p>child</p>, params: Promise.resolve({ orgSlug: "acme", workspaceSlug: "main" }) })
    return render(element)
  }

  it("uses the published template", async () => {
    await renderLayout({ widgets: WIDGETS, template: "bento" })
    expect(screen.getByTestId("portal-shell-bento")).toBeTruthy()
    // docs widget present -> Docs link; the hero keeps its buttons even with an announcement widget
    expect(screen.getByRole("link", { name: "Docs" })).toBeTruthy()
    expect(screen.getByRole("link", { name: /View the roadmap/ })).toBeTruthy()
  })

  it("editorial hero meta is derived from public roadmap and published docs; the hub gets Popular chips from doc titles", async () => {
    await renderLayout({ widgets: WIDGETS, template: "editorial" })
    expect(screen.getByTestId("portal-hero-meta").textContent).toBe("Updated Nov 6, 2026·3 items in progress·2 published docs")
    expect(screen.queryByTestId("hub-popular")).toBeNull()
    cleanup()
    pathname.mockReturnValue("/portal/acme/main")
    await renderLayout({ widgets: WIDGETS, template: "docs_hub" })
    const chips = within(screen.getByTestId("hub-popular")).getAllByRole("button").map((b) => b.textContent)
    expect(chips).toEqual(["Getting started with Acme", "API and webhooks guide"])
    expect(screen.queryByTestId("portal-hero-meta")).toBeNull()
  })

  it("opts in to the app's dark-mode mechanism: theme scope wrapper and a stored 'dark' preference applies the dark class", async () => {
    localStorage.setItem("compass-theme", "dark")
    const { container } = await renderLayout({ widgets: WIDGETS, template: "shell" })
    expect(container.querySelector(".workspace-theme-scope")).toBeTruthy()
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true))
    localStorage.removeItem("compass-theme")
  })

  it("falls back to editorial (with the default home's announcement) before the first publish", async () => {
    await renderLayout({ widgets: null, template: "editorial" })
    expect(screen.getByTestId("portal-shell-editorial")).toBeTruthy()
    expect(screen.queryByRole("link", { name: "Docs" })).toBeNull()
  })
})

describe("editor template picker", () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response(JSON.stringify({ ok: true }), { status: 200 })
      if (String(url).endsWith("/publish")) return new Response(JSON.stringify({ published: WIDGETS, publishedTemplate: "bento", publishedAt: "2026-01-01T00:00:00Z" }), { status: 200 })
      return new Response(JSON.stringify({ resolved: RESOLVED, customerAvailability: {}, roadmapItems: [], docs: [] }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  it("stays in edit mode when a template swap remounts the editor", async () => {
    sessionStorage.setItem("portal-home-editing:/api/portal-home/acme/main", "1")
    render(
      <PortalHomeEditor
        orgSlug="acme" workspaceSlug="main" initialDraft={WIDGETS} initialBaseline={WIDGETS}
        initialTemplate="bento" initialBaselineTemplate="bento" publishedAt="2026-01-01T00:00:00Z"
        initialResolved={RESOLVED} initialCustomerAvailability={{}}
      >
        <p>published board</p>
      </PortalHomeEditor>,
    )
    await waitFor(() => expect(screen.getByTestId("portal-template-picker")).toBeTruthy())
    expect((screen.getByRole("radio", { name: /Bento/ }) as HTMLInputElement).checked).toBe(true)
  })

  it("saves the chosen template with the draft and publishes it", async () => {
    render(
      <PortalHomeEditor
        orgSlug="acme" workspaceSlug="main" initialDraft={WIDGETS} initialBaseline={WIDGETS}
        initialTemplate="editorial" initialBaselineTemplate="editorial" publishedAt="2026-01-01T00:00:00Z"
        initialResolved={RESOLVED} initialCustomerAvailability={{}}
      >
        <p>published board</p>
      </PortalHomeEditor>,
    )
    fireEvent.click(screen.getByRole("button", { name: /Edit home/ }))
    const publish = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement
    expect(publish.disabled).toBe(true)
    fireEvent.click(screen.getByRole("radio", { name: /Bento/ }))
    expect(publish.disabled).toBe(false)
    expect(screen.getByTestId("portal-home-edit-board").getAttribute("data-tpl")).toBe("bento")

    fireEvent.click(publish)
    await waitFor(() => expect(screen.getByText("Published. Customers now see this version.")).toBeTruthy())
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!
    expect(JSON.parse((put[1] as RequestInit).body as string).template).toBe("bento")
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
