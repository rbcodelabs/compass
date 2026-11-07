import type { ReactNode } from "react"
import type { PortalTemplate } from "@/lib/portal-home/templates"
import { PortalAuthStatus } from "@/components/portal/portal-auth-status"
import { PortalNav } from "../portal-nav"
import { BrandMark, PortalFooter } from "./brand"
import { BentoHero, EditorialHero, HubHero, type HeroProps } from "./heroes"
import { HomeOnly, PortalMain } from "./home-only"
import { SidebarShell } from "./sidebar-shell"

export interface PortalShellProps {
  template: PortalTemplate
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  logoUrl: string | null
  roadmapPublic: boolean
  feedbackEnabled: boolean
  /** The signed-in portal customer's email, when there is one. */
  email: string | null
  /** The published home has a docs widget: the nav offers a Docs link to it. */
  showDocs: boolean
  /** The published home has an announcement widget: the hero skips its own buttons. */
  hasAnnouncement: boolean
  children: ReactNode
}

/** The chrome around every portal page (home, roadmap, feedback) for the published template. */
export function PortalShell(props: PortalShellProps) {
  const { template, orgSlug, workspaceSlug, workspaceName, logoUrl, roadmapPublic, feedbackEnabled, email, showDocs, hasAnnouncement, children } = props
  const base = `/portal/${orgSlug}/${workspaceSlug}`
  const nav = (variant: "default" | "onBrand" | "onDark") => (
    <PortalNav orgSlug={orgSlug} workspaceSlug={workspaceSlug} roadmapPublic={roadmapPublic} feedbackEnabled={feedbackEnabled} showDocs={showDocs} variant={variant} />
  )
  const auth = (className: string) => (email ? <div className={className}><PortalAuthStatus email={email} /></div> : null)
  const hero: HeroProps = { name: workspaceName, base, roadmapPublic, feedbackEnabled, hasAnnouncement }

  if (template === "shell") {
    return (
      <SidebarShell
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        workspaceName={workspaceName}
        logoUrl={logoUrl}
        roadmapPublic={roadmapPublic}
        feedbackEnabled={feedbackEnabled}
        showDocs={showDocs}
        authSlot={auth("hidden sm:block")}
      >
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">{children}</main>
      </SidebarShell>
    )
  }

  if (template === "bento") {
    return (
      <div className="flex min-h-screen flex-col bg-surface-app" data-testid="portal-shell-bento">
        <div className="bg-[linear-gradient(135deg,color-mix(in_srgb,var(--primary)_68%,black)_0%,var(--primary)_100%)] text-primary-foreground">
          <header className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3">
            <div className="flex items-center gap-2.5 text-lg font-extrabold tracking-tight">
              <BrandMark name={workspaceName} logoUrl={logoUrl} className="border border-white/35 bg-white/20 text-primary-foreground shadow-none" />
              {workspaceName}
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-3">
              {nav("onBrand")}
              {auth("text-primary-foreground [&_*]:!text-current")}
            </div>
          </header>
          <HomeOnly base={base}><BentoHero {...hero} /></HomeOnly>
        </div>
        <PortalMain base={base} className="relative z-10 mx-auto w-full max-w-5xl flex-1 px-6 py-8" homeClassName="-mt-28 pt-0 md:-mt-32">
          {children}
        </PortalMain>
        <PortalFooter className="bg-surface-panel" />
      </div>
    )
  }

  if (template === "docs_hub") {
    return (
      <div className="flex min-h-screen flex-col bg-surface-app" data-testid="portal-shell-hub">
        <div className="border-b border-[#34302A] bg-[#14110F] text-[#FAF9F6]">
          <header className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-6 py-3.5">
            <div className="flex items-center gap-2.5 font-bold tracking-tight">
              <BrandMark name={workspaceName} logoUrl={logoUrl} />
              {workspaceName}
            </div>
            <div className="ml-2 mr-auto">{nav("onDark")}</div>
            {auth("text-[#B9B3A9] [&_*]:!text-current")}
          </header>
          <HomeOnly base={base}><HubHero {...hero} /></HomeOnly>
        </div>
        <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
        <PortalFooter className="bg-surface-panel" />
      </div>
    )
  }

  // editorial (and the fallback for anything unrecognised): centred header, calm hero on the home page.
  return (
    <div className="flex min-h-screen flex-col bg-surface-app" data-testid="portal-shell-editorial">
      <header className="border-b border-border-default px-6 py-4">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <BrandMark name={workspaceName} logoUrl={logoUrl} className="size-7" />
            <span className="text-sm font-semibold text-text-primary">{workspaceName}</span>
          </div>
          {nav("default")}
          {auth("")}
        </div>
      </header>
      <HomeOnly base={base}><EditorialHero {...hero} /></HomeOnly>
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-8">{children}</main>
      <PortalFooter className="bg-surface-panel" />
    </div>
  )
}
