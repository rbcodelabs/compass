// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ArtifactGalleryForm, ArtifactGalleryRenderer } from "@/components/portal-home/widgets/artifact-gallery"
import { OkrSummaryForm, OkrSummaryRenderer } from "@/components/portal-home/widgets/okr-summary"
import { artifactGalleryDefinition } from "@/lib/portal-home/widgets/artifact-gallery"
import { okrSummaryDefinition } from "@/lib/portal-home/widgets/okr-summary"
import type { HomeOptions } from "@/components/portal-home/types"

afterEach(cleanup)

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const galleryConfig = artifactGalleryDefinition.defaultConfig()
const okrConfig = okrSummaryDefinition.defaultConfig()

const artifact = (n: number, over = {}) => ({
  id: id(n), title: `Artifact ${n}`, kind: null, sourceType: "HTML_UPLOAD", updatedAt: "2026-11-05T10:00:00.000Z",
  href: `/acme/main/docs/artifacts/${id(n)}`, thumbnailSrc: null, ...over,
})
const objective = (n: number, over = {}) => ({ id: id(n), title: `Objective ${n}`, status: "ON_TRACK", progress: 40, keyResultCount: 2, cycleTitle: "Q4 2026", ...over })

const options: HomeOptions = {
  roadmapItems: [],
  docs: [],
  artifacts: [
    { id: id(1), title: "Artifact 1", kind: null, sourceType: "HTML_UPLOAD" },
    { id: id(2), title: "Deck two", kind: "SLIDE_DECK", sourceType: "HTML_UPLOAD" },
    { id: id(3), title: "Artifact 3", kind: null, sourceType: "V0_CHAT" },
  ],
  okrCycles: [{ id: id(10), title: "Q3 2026", status: "COMPLETED" }, { id: id(11), title: "Q4 2026", status: "ACTIVE" }],
  objectives: [{ id: id(1), title: "Objective 1", cycleTitle: "Q4 2026" }, { id: id(2), title: "Objective 2", cycleTitle: null }],
}

describe("Artifact gallery renderer", () => {
  it("renders linked cards with a type badge, the thumbnail when present, and an icon fallback when not", () => {
    const html = renderToStaticMarkup(
      <ArtifactGalleryRenderer
        config={galleryConfig}
        data={{
          type: "artifact_gallery",
          galleryHref: "/acme/main/docs",
          artifacts: [
            artifact(1, { thumbnailSrc: "/api/artifacts/a/revisions/r/thumbnail" }),
            artifact(2, { kind: "SLIDE_DECK" }),
            artifact(3, { sourceType: "V0_CHAT" }),
            artifact(4, { sourceType: "SOMETHING_NEW" }),
          ],
        }}
      />,
    )
    expect(html).toContain(`href="/acme/main/docs/artifacts/${id(1)}"`)
    expect(html).toContain('src="/api/artifacts/a/revisions/r/thumbnail"')
    expect(html.match(/<img/g)).toHaveLength(1)
    expect(html.match(/data-testid="artifact-gallery-thumb"/g)).toHaveLength(4)
    for (const label of ["Prototype", "Deck", "v0", "Artifact</span>"]) expect(html).toContain(label)
    expect(html).toContain("Updated Nov 5, 2026")
    expect(html).toContain('href="/acme/main/docs"')
  })
})

describe("Artifact gallery form", () => {
  it("hides the picker in recent mode and shows artifacts with their type in selected mode", () => {
    const { rerender } = render(<ArtifactGalleryForm config={galleryConfig} options={options} onChange={() => {}} />)
    expect(screen.queryByLabelText("Available artifacts")).toBeNull()
    rerender(<ArtifactGalleryForm config={{ ...galleryConfig, mode: "selected" }} options={options} onChange={() => {}} />)
    expect(screen.getByLabelText("Available artifacts")).toBeTruthy()
    expect(screen.getByText("Deck two")).toBeTruthy()
    expect(screen.getByText("Deck")).toBeTruthy()
  })

  it("picking appends in order, and the arrows reorder and remove", () => {
    const onChange = vi.fn()
    const config = { ...galleryConfig, mode: "selected" as const, artifactIds: [id(2)] }
    const { rerender } = render(<ArtifactGalleryForm config={config} options={options} onChange={onChange} />)
    fireEvent.click(screen.getByRole("checkbox", { name: /Artifact 1/ }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ artifactIds: [id(2), id(1)] }))

    rerender(<ArtifactGalleryForm config={{ ...config, artifactIds: [id(2), id(1)] }} options={options} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Move Artifact 1 up" }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ artifactIds: [id(1), id(2)] }))
    fireEvent.click(screen.getByRole("button", { name: "Remove Deck two" }))
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ artifactIds: [id(1)] }))
  })

  it("keeps a selection outside the options list visible so it can be removed", () => {
    const onChange = vi.fn()
    render(<ArtifactGalleryForm config={{ ...galleryConfig, mode: "selected", artifactIds: [id(99)] }} options={options} onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Remove Selected artifact outside this list" }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ artifactIds: [] }))
  })

  it("disables unchecked rows once the limit is reached, and says it is still loading without options", () => {
    const full = Array.from({ length: 12 }, (_, i) => id(i + 20))
    const many = { ...options, artifacts: [...options.artifacts!, ...full.map((fid, i) => ({ id: fid, title: `Extra ${i}`, kind: null, sourceType: "HTML_UPLOAD" }))] }
    const { rerender } = render(<ArtifactGalleryForm config={{ ...galleryConfig, mode: "selected", artifactIds: full }} options={many} onChange={() => {}} />)
    expect(screen.getByRole("checkbox", { name: /Artifact 1/ }).getAttribute("data-disabled")).not.toBeNull()
    rerender(<ArtifactGalleryForm config={{ ...galleryConfig, mode: "selected" }} options={null} onChange={() => {}} />)
    expect(screen.getByText(/Loading artifacts/)).toBeTruthy()
  })
})

describe("OKR summary renderer", () => {
  const data = { type: "okr_summary" as const, cycleTitle: "Q4 2026", okrsHref: "/acme/main/okrs", objectives: [objective(1), objective(2, { status: "OFF_TRACK", progress: 100, keyResultCount: 1 })] }

  it("renders status, an accessible progress bar per objective, key result counts and the cycle subtitle", () => {
    const html = renderToStaticMarkup(<OkrSummaryRenderer config={okrConfig} data={data} />)
    expect(html).toContain("Q4 2026")
    expect(html).toContain("On track")
    expect(html).toContain("Off track")
    expect(html).toContain('aria-valuenow="40"')
    expect(html).toContain("width:100%")
    expect(html).toContain("2 key results")
    expect(html).toContain("1 key result<")
    expect(html).toContain('href="/acme/main/okrs"')
  })

  it("shows each objective's own cycle only when the objectives are hand-picked", () => {
    const active = renderToStaticMarkup(<OkrSummaryRenderer config={okrConfig} data={{ ...data, cycleTitle: null }} />)
    expect(active).not.toContain("· Q4 2026")
    const selected = renderToStaticMarkup(<OkrSummaryRenderer config={{ ...okrConfig, mode: "selected" }} data={{ ...data, cycleTitle: null }} />)
    expect(selected).toContain("· Q4 2026")
  })

  it("falls back to a neutral badge for an unknown status", () => {
    const html = renderToStaticMarkup(<OkrSummaryRenderer config={okrConfig} data={{ ...data, objectives: [objective(1, { status: "PAUSED" })] }} />)
    expect(html).toContain("PAUSED")
  })
})

describe("OKR summary form", () => {
  it("shows nothing extra in active mode, a cycle dropdown in cycle mode, and the objective picker in selected mode", () => {
    const { rerender } = render(<OkrSummaryForm config={okrConfig} options={options} onChange={() => {}} />)
    expect(screen.queryByLabelText("Available objectives")).toBeNull()
    expect(screen.queryByText("Cycle")).toBeNull()
    rerender(<OkrSummaryForm config={{ ...okrConfig, mode: "cycle" }} options={options} onChange={() => {}} />)
    expect(screen.getByText("Cycle")).toBeTruthy()
    expect(screen.queryByLabelText("Available objectives")).toBeNull()
    rerender(<OkrSummaryForm config={{ ...okrConfig, mode: "selected" }} options={options} onChange={() => {}} />)
    expect(screen.getByLabelText("Available objectives")).toBeTruthy()
    expect(screen.getByText("No cycle")).toBeTruthy()
  })

  it("picking objectives appends in order across cycles", () => {
    const onChange = vi.fn()
    render(<OkrSummaryForm config={{ ...okrConfig, mode: "selected", objectiveIds: [id(2)] }} options={options} onChange={onChange} />)
    fireEvent.click(screen.getByRole("checkbox", { name: /Objective 1/ }))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ objectiveIds: [id(2), id(1)] }))
  })

  it("explains an empty cycle list in cycle mode", () => {
    render(<OkrSummaryForm config={{ ...okrConfig, mode: "cycle" }} options={{ ...options, okrCycles: [] }} onChange={() => {}} />)
    expect(screen.getByText("No OKR cycles yet.")).toBeTruthy()
  })
})
