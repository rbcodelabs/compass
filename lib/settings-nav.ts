/**
 * Single source of truth for the settings navigation shown on every settings
 * screen (account, workspace and organization). Pure so it can be unit tested
 * and so the three route trees cannot drift apart again.
 *
 * Scope groups: Account (applies to you everywhere), Workspace (one
 * workspace), Organization (every workspace in the org, admins only).
 */
export type SettingsNavItem = { href: string; label: string; adminOnly?: boolean };
export type SettingsNavGroup = {
  id: "account" | "workspace" | "organization" | "platform";
  label: string;
  sublabel?: string;
  items: SettingsNavItem[];
};

export type SettingsNavContext = {
  /** Anchor org/workspace for scoped links. Null when the user has no workspace. */
  orgSlug: string | null;
  workspaceSlug: string | null;
  workspaceName?: string | null;
  orgName?: string | null;
  isOrgAdmin: boolean;
  isPlatformAdmin?: boolean;
};

export function buildSettingsNav(ctx: SettingsNavContext): SettingsNavGroup[] {
  const groups: SettingsNavGroup[] = [
    {
      id: "account",
      label: "Account",
      sublabel: "Applies to you everywhere",
      items: [
        { href: "/settings/profile", label: "Profile" },
        { href: "/settings/passkeys", label: "Passkeys" },
        { href: "/settings/agents", label: "My agents" },
      ],
    },
  ];

  if (ctx.orgSlug && ctx.workspaceSlug) {
    const base = "/" + ctx.orgSlug + "/" + ctx.workspaceSlug + "/settings";
    groups.push({
      id: "workspace",
      label: "Workspace",
      sublabel: ctx.workspaceName ?? undefined,
      items: [
        { href: base, label: "Workspace settings" },
        { href: base + "/modules", label: "Modules" },
      ],
    });
  }

  if (ctx.orgSlug && ctx.isOrgAdmin) {
    groups.push({
      id: "organization",
      label: "Organization",
      sublabel: ctx.orgName ?? undefined,
      items: [{ href: "/" + ctx.orgSlug + "/settings", label: "Organization settings", adminOnly: true }],
    });
  }

  if (ctx.isPlatformAdmin) {
    groups.push({
      id: "platform",
      label: "Platform",
      items: [{ href: "/settings/admin/agent-snapshot", label: "Agent snapshot", adminOnly: true }],
    });
  }

  return groups;
}

/**
 * The item that owns the pathname: the longest matching href, so the Modules
 * page selects Modules rather than Workspace settings.
 */
export function activeSettingsHref(groups: SettingsNavGroup[], pathname: string): string | null {
  let best: string | null = null;
  for (const item of groups.flatMap((g) => g.items)) {
    const matches = pathname === item.href || pathname.startsWith(item.href + "/");
    if (matches && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}
