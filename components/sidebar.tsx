"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  FlaskConical,
  HelpCircle,
  Lightbulb,
  ListChecks,
  Map,
  MessageSquare,
  MessageSquareCheck,
  Settings,
  Sparkles,
  Target,
  Waypoints,
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

interface SidebarProps {
  orgSlug: string
  workspaceSlug: string
  workspaceName: string
  userName: string
  userEmail: string
  userImage?: string
  workspaces: { id: string; name: string; slug: string; orgSlug: string }[]
  /** Org admins/owners see an "Org Settings" link in the account menu. */
  isOrgAdmin?: boolean
  researchCaptureEnabled?: boolean
}

const baseNavItems = [
  { label: "OKRs", path: "okrs", Icon: Target },
  { label: "Discovery", path: "discovery", Icon: Lightbulb },
  { label: "Experiments", path: "experiments", Icon: FlaskConical },
  { label: "Roadmap", path: "roadmap", Icon: Map },
  { label: "Tasks", path: "tasks", Icon: ListChecks },
  { label: "Decisions", path: "decisions", Icon: MessageSquareCheck },
  { label: "Docs", path: "docs", Icon: BookOpen },
  { label: "Canvas", path: "canvas", Icon: Waypoints },
  { label: "Agent", path: "agent", Icon: Sparkles },
]

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
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const base = `/${orgSlug}/${workspaceSlug}`
  const navItems = [
    ...baseNavItems.slice(0, 5),
    researchCaptureEnabled
      ? { label: "Capture", path: "capture", Icon: MessageSquare }
      : { label: "Feedback", path: "feedback", Icon: MessageSquare },
    ...baseNavItems.slice(5),
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
                    <span className="truncate">{workspace.name}</span>
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
                    Help
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem className="cursor-pointer p-0" closeOnClick={false}>
                  <SendCompassFeedbackDialog />
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="cursor-pointer p-0">
                  <Link href="/settings/agents" className="flex w-full items-center px-1.5 py-1">My agents</Link>
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
