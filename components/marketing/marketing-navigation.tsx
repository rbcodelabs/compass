"use client"

import { ChevronDown, HelpCircle, LayoutDashboard, LogOut } from "lucide-react"
import Link from "next/link"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { signOutAction } from "@/lib/actions/auth-actions"
import type { MarketingViewer } from "@/lib/marketing-viewer"

function getInitials(name: string, email: string): string {
  const source = name.trim() || email.split("@")[0] || "?"
  return source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

function MenuLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <DropdownMenuItem className="cursor-pointer p-0">
      <Link href={href} className="flex w-full items-center gap-2 px-2 py-1.5">
        {children}
      </Link>
    </DropdownMenuItem>
  )
}

function AccountMenu({ viewer }: { viewer: Exclude<MarketingViewer, { kind: "signed-out" }> }) {
  const primaryHref = viewer.kind === "no-workspaces" ? "/onboarding" : "/dashboard"
  const primaryLabel = viewer.kind === "no-workspaces" ? "Set up workspace" : "Dashboard"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full" />
        }
      >
        <Avatar className="size-8" data-has-image={viewer.user.image ? "true" : "false"}>
          {viewer.user.image && <AvatarImage src={viewer.user.image} alt={viewer.user.name} />}
          <AvatarFallback className="bg-surface-interactive text-xs font-semibold text-primary">
            {getInitials(viewer.user.name, viewer.user.email)}
          </AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="min-w-0 px-2 py-1.5">
          <p className="truncate text-sm font-medium text-text-primary">{viewer.user.name}</p>
          {viewer.user.email && <p className="truncate text-xs text-text-muted">{viewer.user.email}</p>}
        </div>
        <DropdownMenuSeparator />
        <MenuLink href={primaryHref}>
          <LayoutDashboard aria-hidden="true" />
          {primaryLabel}
        </MenuLink>
        <MenuLink href="/settings/agents">My agents</MenuLink>
        <MenuLink href="/help">
          <HelpCircle aria-hidden="true" />
          User Guide
        </MenuLink>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="cursor-pointer p-0">
          <form action={signOutAction} className="w-full">
            <Button type="submit" variant="ghost" size="sm" className="w-full justify-start gap-2 px-2">
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function MarketingNavigation({ viewer }: { viewer: MarketingViewer }) {
  if (viewer.kind === "signed-out") {
    return (
      <Link href="/login" className="text-sm text-text-secondary transition-colors hover:text-text-primary">
        Sign in
      </Link>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {viewer.kind === "no-workspaces" && (
        <Link href="/onboarding" className={buttonVariants({ size: "sm" })}>Set up workspace</Link>
      )}
      {viewer.kind === "single-workspace" && (
        <Link href="/dashboard" className={buttonVariants({ size: "sm" })}>Dashboard</Link>
      )}
      {viewer.kind === "multiple-workspaces" && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" aria-label="Choose workspace" className="max-w-44" />}
          >
            <span className="truncate">Workspaces</span>
            <ChevronDown aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72 max-w-[calc(100vw-2rem)]">
            {viewer.workspaces.map((workspace) => (
              <DropdownMenuItem key={workspace.id} className="cursor-pointer p-0">
                <Link
                  href={`/${workspace.orgSlug}/${workspace.slug}/okrs`}
                  aria-label={`${workspace.name} ${workspace.orgName}`}
                  className="flex w-full items-center gap-2 px-2 py-1.5"
                >
                <span className="min-w-0">
                  <span className="block truncate font-medium">{workspace.name}</span>
                  <span className="block truncate text-xs text-text-muted">{workspace.orgName}</span>
                </span>
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <MenuLink href="/dashboard">All workspaces</MenuLink>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AccountMenu viewer={viewer} />
    </div>
  )
}
