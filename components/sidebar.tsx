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
      className="border-white/10 bg-surface-navigation text-text-inverse"
    >
      <SidebarHeader className="gap-2 px-2 py-3">
        <div className="flex h-8 items-center gap-2 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 group-data-[collapsible=icon]:hidden">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary shadow-sm">
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
            className="size-8 text-text-inverse/55 hover:bg-surface-navigation-active hover:text-text-inverse"
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
                    className="text-text-inverse/80 hover:bg-surface-navigation-active hover:text-text-inverse data-open:bg-surface-navigation-active"
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
                <ChevronDown className="ml-auto size-3 text-text-inverse/40 group-data-[collapsible=icon]:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                className="min-w-56 bg-slate-900 text-slate-200 ring-slate-700"
              >
                {workspaces.map((workspace) => (
                  <DropdownMenuItem
                    key={workspace.id}
                    className="flex cursor-pointer items-center gap-2 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100"
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
                    <DropdownMenuSeparator className="bg-slate-700" />
                    <DropdownMenuItem
                      disabled
                      className="cursor-default text-slate-500 focus:bg-transparent focus:text-slate-500"
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

      <SidebarSeparator className="bg-white/10" />

      <SidebarContent>
        <SidebarGroup className="py-3">
          <SidebarGroupContent>
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
                      className="relative h-9 rounded-lg text-text-inverse/60 hover:bg-surface-navigation-active hover:text-text-inverse data-active:bg-surface-navigation-active data-active:text-text-inverse"
                    >
                      {isActive && (
                        <span
                          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary group-data-[collapsible=icon]:hidden"
                          aria-hidden="true"
                        />
                      )}
                      <Icon
                        className={
                          isActive ? "text-primary" : "text-text-inverse/40"
                        }
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

      <SidebarSeparator className="bg-white/10" />

      <SidebarFooter className="px-2 py-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <SidebarMenuButton
                    size="lg"
                    tooltip={userName}
                    className="text-text-inverse/60 hover:bg-surface-navigation-active hover:text-text-inverse data-open:bg-surface-navigation-active"
                    aria-label="Account menu"
                  />
                }
              >
                <Avatar className="size-7 shrink-0">
                  {userImage && <AvatarImage src={userImage} alt={userName} />}
                  <AvatarFallback className="bg-surface-navigation-active text-[10px] font-semibold text-text-inverse">
                    {getInitials(userName || "?")}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-xs">{userName}</span>
                <ChevronDown className="ml-auto size-3 text-text-inverse/40 group-data-[collapsible=icon]:hidden" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="end"
                className="min-w-56 bg-slate-900 text-slate-200 ring-slate-700"
              >
                <div className="px-1.5 py-1">
                  <p className="truncate text-sm font-medium text-slate-100">{userName}</p>
                  <p className="truncate text-xs text-slate-500">{userEmail}</p>
                </div>
                <DropdownMenuSeparator className="bg-slate-700" />
                <DropdownMenuItem className="cursor-pointer p-0 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100">
                  <Link href={`${base}/settings`} className="flex w-full items-center gap-2 px-1.5 py-1">
                    <Settings className="size-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                {isOrgAdmin && (
                  <DropdownMenuItem className="cursor-pointer p-0 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100">
                    <Link href={`/${orgSlug}/settings`} className="flex w-full items-center gap-2 px-1.5 py-1">
                      <Building2 className="size-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                      Org Settings
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem className="cursor-pointer p-0 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100">
                  <Link href="/help" className="flex w-full items-center gap-2 px-1.5 py-1">
                    <HelpCircle className="size-3.5 shrink-0 text-slate-500" aria-hidden="true" />
                    Help
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="cursor-pointer p-0 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100"
                  closeOnClick={false}
                >
                  <SendCompassFeedbackDialog />
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-slate-700" />
                <DropdownMenuItem className="cursor-pointer p-0 hover:bg-slate-800 focus:bg-slate-800 focus:text-slate-100">
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
