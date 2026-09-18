---
title: "Members"
description: "Add teammates to a workspace and manage their roles"
icon: "Users"
order: 10
section: "Configuration"
---

# Members

Workspace members are the people who have access to a workspace. Every object, setting, and page in a workspace is scoped to its members — someone who isn't a member of a workspace cannot view or act on it, even if they know the URL.

## Adding a Member

Managing members is an admin-only action: adding, changing a role, and removing all require workspace Admin (or an Owner/Admin of the organization). Members can view the list but not change it.

Go to **Settings → Members** and click **Add member**. Enter the person's email address and choose a role:

- **Member** — Standard access to the workspace's OKRs, discovery, experiments, roadmap, feedback, and docs.
- **Admin** — Everything a Member can do, plus managing workspace settings, squads, custom fields, and other members.

Those are the only two workspace roles. Organization roles are separate — see [Organization owners and admins](#organization-owners-and-admins) below.

If the email doesn't match anyone who has signed in to Compass before, adding them still works — a placeholder account is created immediately, and they get full access the moment they sign in with that email address. There's no separate invite-acceptance step.

Adding someone to a workspace also adds them to the workspace's parent organization (as a Member) if they aren't already part of it.

## Changing a Member's Role

Admins can use the role dropdown next to a member's name to switch them between Member and Admin. Changes take effect immediately.

You can't demote the workspace's last remaining Admin — promote someone else to Admin first.

## Organization Owners and Admins

A workspace has exactly two roles, Member and Admin. An organization has three: Owner, Admin, and Member. The organization Owner role is deliberately absent from the workspace role dropdown — it is not a workspace role.

Anyone who is an **Owner or Admin of the organization** is treated as an Admin of every workspace in that organization, regardless of what their workspace role says. So an organization owner can always reach workspace settings, including the scoring model, and cannot be locked out of a workspace their organization owns.

## Removing a Member

Click the trash icon next to a member's name to remove their access to the workspace. This does not delete their Compass account or affect their access to any other workspace.

You can't remove the last member of a workspace, and you can't remove the last remaining Admin — promote another member to Admin first if you need to remove the current one.

## Creating a Workspace

Workspaces are created from **Organization Settings**, which is a different page from a workspace's own Settings — it covers the organization as a whole rather than one workspace inside it. Only an organization Owner or Admin can reach it.

Open **Organization Settings → Workspaces** and click **Create workspace**. The form asks for:

- **Name** — what the workspace is called, e.g. "Product Team".
- **URL slug** — the part that appears in the address bar, as in `/your-org/product-team`. It fills in automatically as you type the name, and you can edit it. Slugs may contain lowercase letters, numbers, and hyphens only, and no two workspaces in the same organization can share one.
- **Description** — optional.

**Every member of the organization is automatically added to the new workspace.** There is no separate step to invite people into it, and nobody in the organization has to be added by hand afterwards. Organization Owners and Admins become workspace Admins; everyone else becomes a workspace Member. You can adjust individual roles afterwards from that workspace's own **Settings → Members**.

On success you land directly in the new workspace's OKRs page, and it appears in the workspace switcher at the top of the sidebar.

Your organization's *first* workspace is created for you when you sign up, as part of onboarding — this page is for adding further ones later.

## Deleting a Workspace

Deleting a workspace is an admin-only action found in **Settings**, in a dedicated danger-zone panel. Click **Delete workspace**, then type the workspace's exact name to confirm — the delete button stays disabled until the typed name matches.

Deleting a workspace permanently removes all of its data, including OKRs, opportunities, experiments, roadmap items, and feedback. This action cannot be undone.
