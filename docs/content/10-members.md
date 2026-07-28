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

Go to **Settings → Members** and click **Add member**. Enter the person's email address and choose a role:

- **Member** — Standard access to the workspace's OKRs, discovery, experiments, roadmap, feedback, and docs.
- **Admin** — Everything a Member can do, plus managing workspace settings, squads, custom fields, and other members.

If the email doesn't match anyone who has signed in to Compass before, adding them still works — a placeholder account is created immediately, and they get full access the moment they sign in with that email address. There's no separate invite-acceptance step.

Adding someone to a workspace also adds them to the workspace's parent organization (as a Member) if they aren't already part of it.

## Changing a Member's Role

In the Members list, use the role dropdown next to a member's name to switch them between Member and Admin. Changes take effect immediately.

You can't demote the workspace's last remaining Admin — promote someone else to Admin first.

## Removing a Member

Click the trash icon next to a member's name to remove their access to the workspace. This does not delete their Compass account or affect their access to any other workspace.

You can't remove the last member of a workspace, and you can't remove the last remaining Admin — promote another member to Admin first if you need to remove the current one.

## Deleting a Workspace

Deleting a workspace is an admin-only action found in **Settings**, in a dedicated danger-zone panel. Click **Delete workspace**, then type the workspace's exact name to confirm — the delete button stays disabled until the typed name matches.

Deleting a workspace permanently removes all of its data, including OKRs, opportunities, experiments, roadmap items, and feedback. This action cannot be undone.
