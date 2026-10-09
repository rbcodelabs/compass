"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  BarChart3,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  FlaskConical,
  HelpCircle,
  Lightbulb,
  Puzzle,
  ListChecks,
  Map,
  MessageSquare,
  MessageSquareCheck,
  Microscope,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Target,
  Waypoints,
  Clock3,
  House,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar as SidebarRoot,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { SendCompassFeedbackDialog } from "@/components/feedback/send-compass-feedback-dialog"
import { signOutAction } from "@/lib/actions/auth-actions"
import { getWorkspaceSwitchPath } from "@/lib/workspace-nav"
import { WorkspaceSearchPalette } from "@/components/workspace-search-palette"
import { useAgentRailOptional } from "@/components/agent/agent-rail-context"
import { useLabels } from "@/components/thinking-model/thinking-model-provider"
import { orderPrimaryNav } from "@/lib/workspace-nav"
import { NotificationBellNavItem } from "@/components/notifications/notification-bell"

interface SidebarProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  userName: string
  userEmail: string
  userImage?: string
  workspaces: { id: string; name: string; slug: string; orgSlug: string; isReadOnly?: boolean }[]
  /** Org admins/owners see an "Org Settings" link in the account menu. */
  isOrgAdmin?: boolean
  researchCaptureEnabled?: boolean
  updatesEnabled?: boolean
  /** Following is on and available: show the notifications bell. Absent in the settings tree. */
  followingEnabled?: boolean
  unreadNotifications?: { count: number; overflow: boolean }
}

// A function, not a constant, because the OKRs entry's name comes from the
// workspace's thinking model ("OKRs" by default, "Outcomes" under Torres).
const buildBaseNavItems = (okrsLabel: string, discoveryLabel: string, solutionsLabel: string, discoveryFirst: boolean) => orderPrimaryNav([
  { label: okrsLabel, path: "okrs", Icon: Target },
  { label: discoveryLabel, path: "discovery", Icon: Lightbulb },
  { label: solutionsLabel, path: "solutions", Icon: Puzzle },
  { label: "Experiments", path: "experiments", Icon: FlaskConical },
  { label: "Roadmap", path: "roadmap", Icon: Map },
  { label: "Metrics", path: "metrics", Icon: BarChart3 },
  { label: "Tasks", path: "tasks", Icon: ListChecks },
  { label: "Decisions", path: "decisions", Icon: MessageSquareCheck },
  { label: "Docs", path: "docs", Icon: BookOpen },
  { label: "Canvas", path: "canvas", Icon: Waypoints },
  { label: "Agent", path: "agent", Icon: Sparkles },
], discoveryFirst)

/**
 * Opens/closes the rail (Agent, Help and Library views, switched from the rail header). Lives in the footer beside the
 * account menu rather than in the main nav.
 *
 * The nav's Agent row has to stay a plain link to the full-page agent screen —
 * both surfaces are keepers, and the page is the one that survives a refresh and
 * a shared URL. A sibling menu row (not `SidebarMenuAction`, which hides when
 * the nav collapses to icons) keeps the control visible in both nav states.
 * Help is one view over, or "?" from anywhere.
 *
 * Returns `null` outside a workspace — this sidebar also renders in the settings
 * tree, which mounts no `AgentRailProvider` and has no rail to toggle. Also
 * absent on the full-page agent screen, which already runs its own live chat.
 */
function AgentRailToggle() {
  const rail = useAgentRailOptional()
  if (!rail?.available) return null

  const Icon = rail.open ? PanelLeftClose : PanelLeftOpen

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={rail.toggleRail}
        // Not `isActive`: that styling means "this is the page you are on".
        // Open-ness is a pressed state, which screen readers announce here.
        aria-pressed={rail.open}
        tooltip={rail.open ? "Hide agent (⌘J)" : "Show agent (⌘J)"}
        className="text-text-secondary"
      >
        <Icon className={rail.open ? "text-primary" : "text-text-subtle"} aria-hidden="true" />
        <span>Agent</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export function Sidebar({
  orgSlug,
  workspaceSlug,
  workspaceName,
  userName,
  userEmail,
  userImage,
  workspaces,
  isOrgAdmin = false,
  researchCaptureEnabled = true,
  updatesEnabled = false,
  followingEnabled = false,
  unreadNotifications = { count: 0, overflow: false },
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const base = `/${orgSlug}/${workspaceSlug}`
  const labels = useLabels()
  const baseNavItems = buildBaseNavItems(labels.sections.okrs, labels.opportunity.plural, labels.solution.plural, labels.sections.discoveryFirst)
  const navItems = [
    { label: "Home", path: "home", Icon: House },
    ...(updatesEnabled ? [{ label: "Updates", path: "updates", Icon: Clock3 }] : []),
    ...baseNavItems.slice(0, 6),
    { label: "Feedback", path: "feedback", Icon: MessageSquare },
    ...(researchCaptureEnabled ? [{ label: "Research", path: "capture", Icon: Microscope }] : []),
    ...baseNavItems.slice(6),
  ]

  const otherWorkspaces = workspaces.filter(
    (workspace) =>
      !(workspace.slug === workspaceSlug && workspace.orgSlug === orgSlug)
  )

  return (
    <SidebarRoot
      collapsible="icon"
      className="border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <SidebarHeader className="gap-2 px-2 py-3">
        <div className="flex h-8 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 group-data-[collapsible=icon]:hidden">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="white"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="size-4"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
              </svg>
            </div>
            <span className="truncate text-sm font-semibold tracking-tight">Compass</span>
          </div>
          <SidebarTrigger
            className="size-8 text-text-subtle hover:bg-sidebar-accent hover:text-sidebar-foreground"
            title="Toggle sidebar (⌘/Ctrl+B)"
          />
        </div>

        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    tooltip={`Workspace: ${workspaceName}`}
                    className="text-text-secondary hover:bg-sidebar-accent hover:text-sidebar-foreground data-open:bg-sidebar-accent"
                    aria-label={`Switch workspace. Current workspace: ${workspaceName}`}
                  />
                }
              >
                <div className="flex size-6 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/20">
                  <span className="text-[10px] font-bold leading-none text-primary">
                    {workspaceName[0]?.toUpperCase() ?? "W"}
                  </span>
                </div>
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {workspaceName}
                </span>
                <ChevronDown className="ml-auto size-3 text-text-subtle group-data-[collapsible=icon]:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="min-w-56">
                {workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    className="flex cursor-pointer items-center gap-2"
                    onClick={() =>
                      router.push(
                        getWorkspaceSwitchPath(
                          pathname,
                          orgSlug,
                          workspaceSlug,
                          workspace.orgSlug,
                          workspace.slug
                        )
                      )
                    }
                  >
                    <div className="flex size-4 shrink-0 items-center justify-center">
                      {workspace.slug === workspaceSlug &&
                        workspace.orgSlug === orgSlug && (
                          <Check className="size-3.5 text-primary" aria-hidden="true" />
                        )}
                    </div>
                    <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                    {workspace.isReadOnly && (
                      <span className="shrink-0 rounded border border-border-default px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-subtle">
                        Read-only
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
                {otherWorkspaces.length === 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      disabled
                      className="cursor-default text-text-disabled focus:bg-transparent focus:text-text-disabled"
                    >
                      No other workspaces
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarSeparator />

      <SidebarContent>
        <SidebarGroup className="py-3">
          <SidebarGroupContent>
            <SidebarMenu className="mb-2">
              <SidebarMenuItem>
                <WorkspaceSearchPalette orgSlug={orgSlug} workspaceSlug={workspaceSlug} />
              </SidebarMenuItem>
            </SidebarMenu>
            <nav aria-label="Main navigation">
              <SidebarMenu className="gap-0.5">
              {followingEnabled && (
                <NotificationBellNavItem
                  orgSlug={orgSlug}
                  workspaceSlug={workspaceSlug}
                  initialCount={unreadNotifications.count}
                  initialOverflow={unreadNotifications.overflow}
                />
              )}
              {navItems.map(({ label, path, Icon }) => {
                const href = `${base}/${path}`
                const isActive = pathname.startsWith(href)

                return (
                  <SidebarMenuItem key={path}>
                    <SidebarMenuButton
                      render={<Link href={href} />}
                      isActive={isActive}
                      tooltip={label}
                      className="relative h-9 rounded-lg text-text-secondary"
                    >
                      {isActive && (
                        <span
                          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary group-data-[collapsible=icon]:hidden"
                          aria-hidden="true"
                        />
                      )}
                      <Icon
                        className={isActive ? "text-primary" : "text-text-subtle"}
                        aria-hidden="true"
                      />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
              </SidebarMenu>
            </nav>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />

      <SidebarFooter className="px-2 py-3">
        <SidebarMenu>
          <AgentRailToggle />
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    tooltip={userName}
                    className="text-text-secondary hover:bg-sidebar-accent hover:text-sidebar-foreground data-open:bg-sidebar-accent"
                    aria-label="Account menu"
                  />
                }
              >
                <Avatar className="size-7 shrink-0">
                  {userImage && <AvatarImage src={userImage} alt={userName} />}
                  <AvatarFallback className="bg-sidebar-accent text-[10px] font-semibold text-sidebar-foreground">
                    {getInitials(userName || "?")}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-xs">{userName}</span>
                <ChevronDown className="ml-auto size-3 text-text-subtle group-data-[collapsible=icon]:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="end" className="min-w-56">
                <div className="px-1.5 py-1">
                  <p className="truncate text-sm font-medium text-text-primary">{userName}</p>
                  <p className="truncate text-xs text-text-subtle">{userEmail}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer p-0">
                  <Link href={`${base}/settings`} className="flex w-full items-center gap-2 px-1.5 py-1">
                    <Settings className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                {isOrgAdmin && (
                  <DropdownMenuItem className="cursor-pointer p-0">
                    <Link href={`/${orgSlug}/settings`} className="flex w-full items-center gap-2 px-1.5 py-1">
                      <Building2 className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                      Org Settings
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="cursor-pointer p-0">
                  <Link href="/help" className="flex w-full items-center gap-2 px-1.5 py-1">
                    <HelpCircle className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
                    User Guide
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer p-0" closeOnClick={false}>
                  <SendCompassFeedbackDialog />
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer p-0">
                  <Link href="/settings/profile" className="flex w-full items-center px-1.5 py-1">Profile</Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer p-0">
                  <Link href="/settings/agents" className="flex w-full items-center px-1.5 py-1">My agents</Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer p-0">
                  <Link href="/settings/passkeys" className="flex w-full items-center px-1.5 py-1">Passkeys</Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer p-0">
                  <form action={signOutAction} className="w-full">
                    <Button type="submit" variant="ghost" size="sm" className="w-full justify-start">
                      Sign out
                    </Button>
                  </form>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </SidebarRoot>
  )
}
