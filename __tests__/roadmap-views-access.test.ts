import { describe, expect, it } from "vitest"
import {
  canCreateView, canDeleteView, canEditView, canSeeView, canShareOnSurface, canUseSurface,
  type RoadmapViewActor, type RoadmapViewAccessRow,
} from "@/lib/roadmap-views/access"

const ORG = "org-1"
const WS_A = "ws-a"
const WS_B = "ws-b"

const actor = (over: Partial<RoadmapViewActor> = {}): RoadmapViewActor => ({
  userId: "me", organizationId: ORG, isOrgAdmin: false,
  workspaces: [{ id: WS_A, isReadOnly: false, isAdmin: false }],
  ...over,
})
const view = (over: Partial<RoadmapViewAccessRow> = {}): RoadmapViewAccessRow => ({
  organizationId: ORG, workspaceId: null, ownerId: "me", visibility: "PERSONAL", ...over,
})
const readOnly = actor({ workspaces: [{ id: WS_A, isReadOnly: true, isAdmin: false }] })

describe("surface access", () => {
  it("org surface needs at least one reachable workspace; workspace surface needs that workspace", () => {
    expect(canUseSurface(actor(), null)).toBe(true)
    expect(canUseSurface(actor({ workspaces: [] }), null)).toBe(false)
    expect(canUseSurface(actor(), WS_A)).toBe(true)
    expect(canUseSurface(actor(), WS_B)).toBe(false)
  })

  it("read-only members can use a surface but not share on it; org admins always can", () => {
    expect(canShareOnSurface(readOnly, null)).toBe(false)
    expect(canShareOnSurface(readOnly, WS_A)).toBe(false)
    expect(canShareOnSurface(actor(), null)).toBe(true)
    expect(canShareOnSurface(actor(), WS_A)).toBe(true)
    expect(canShareOnSurface(actor(), WS_B)).toBe(false)
    expect(canShareOnSurface({ ...readOnly, isOrgAdmin: true }, WS_A)).toBe(true)
    expect(canShareOnSurface({ ...actor({ workspaces: [] }), isOrgAdmin: true }, null)).toBe(false)
  })
})

describe("seeing views", () => {
  it("owner sees their personal view; others do not", () => {
    expect(canSeeView(actor(), view())).toBe(true)
    expect(canSeeView(actor(), view({ ownerId: "someone" }))).toBe(false)
  })

  it("shared views are visible to anyone on the surface, but not off it", () => {
    expect(canSeeView(actor(), view({ ownerId: "someone", visibility: "SHARED" }))).toBe(true)
    expect(canSeeView(actor(), view({ ownerId: "someone", visibility: "SHARED", workspaceId: WS_B }))).toBe(false)
    expect(canSeeView(actor({ workspaces: [] }), view({ ownerId: "someone", visibility: "SHARED" }))).toBe(false)
  })

  it("never crosses organizations, even for the owner", () => {
    expect(canSeeView(actor(), view({ organizationId: "other-org" }))).toBe(false)
    expect(canSeeView(actor(), view({ organizationId: "other-org", visibility: "SHARED", ownerId: "x" }))).toBe(false)
  })

  it("an owner who lost workspace access can no longer see their own workspace view", () => {
    expect(canSeeView(actor(), view({ workspaceId: WS_B }))).toBe(false)
  })
})

describe("creating, editing, deleting", () => {
  it("anyone on the surface may create personal; sharing needs a share seat", () => {
    expect(canCreateView(readOnly, null, "PERSONAL")).toBe(true)
    expect(canCreateView(readOnly, null, "SHARED")).toBe(false)
    expect(canCreateView(actor(), WS_A, "SHARED")).toBe(true)
    expect(canCreateView(actor(), WS_B, "PERSONAL")).toBe(false)
  })

  it("only the owner edits content, even when the view is shared", () => {
    const shared = view({ ownerId: "someone", visibility: "SHARED" })
    expect(canEditView(actor(), shared, "SHARED")).toBe(false)
    expect(canEditView(actor({ isOrgAdmin: true }), shared, "SHARED")).toBe(false)
    expect(canEditView(actor(), view(), "PERSONAL")).toBe(true)
  })

  it("re-publishing needs a share seat; un-sharing never does", () => {
    expect(canEditView(readOnly, view(), "SHARED")).toBe(false)
    expect(canEditView(readOnly, view({ visibility: "SHARED" }), "PERSONAL")).toBe(true)
  })

  it("owner deletes own; surface admins may remove a SHARED view, never someone's personal one", () => {
    const sharedByOther = view({ ownerId: "someone", visibility: "SHARED", workspaceId: WS_A })
    const personalOfOther = view({ ownerId: "someone", visibility: "PERSONAL", workspaceId: WS_A })
    const wsAdmin = actor({ workspaces: [{ id: WS_A, isReadOnly: false, isAdmin: true }] })
    expect(canDeleteView(actor(), view())).toBe(true)
    expect(canDeleteView(actor(), sharedByOther)).toBe(false)
    expect(canDeleteView(wsAdmin, sharedByOther)).toBe(true)
    expect(canDeleteView(wsAdmin, personalOfOther)).toBe(false)
    expect(canDeleteView(actor({ isOrgAdmin: true }), { ...sharedByOther, workspaceId: null })).toBe(true)
    expect(canDeleteView(wsAdmin, { ...sharedByOther, workspaceId: null })).toBe(false)
  })
})
