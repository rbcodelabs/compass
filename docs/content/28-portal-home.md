---
title: "Portal home"
description: "Build the customer portal's home page from widgets: announcements, key links, roadmap spotlight, feedback and recent updates"
icon: "LayoutDashboard"
order: 28
section: "Core Features"
---

# Portal home

The **portal home** is the first page customers see at `/portal/[org]/[workspace]`. It is a board of widgets that you arrange and publish yourself. Until you publish a layout, customers see a sensible default: a welcome announcement, the roadmap, recently shipped work, and a feedback prompt, each shown only if the matching portal surface is switched on.

## Editing the home

Workspace admins (and admins of the owning organization) see an admin bar above the home. Select **Edit home** to:

- **Add a widget** with **Add widget**, then pick a type.
- **Reorder** by dragging the handle on a widget. The handle also works from the keyboard.
- **Resize** with **S**, **M** or **L**. On a desktop-width screen the board has six columns: S takes two, M three, L all six. On a phone every widget is full width.
- **Configure** by selecting a widget; its settings open in the right-hand panel. **Remove widget** is at the bottom of the panel.
- **Preview as customer** shows exactly what a signed-out customer would be sent, using the same server code as the live page.

Changes save to a **draft** automatically. Customers keep seeing the published version until you select **Publish**, which copies the draft to the live home.

## Widget types

| Widget | What it shows |
|---|---|
| Announcement | A hero message with up to two buttons. Links may be `https://` URLs or paths such as `/portal/...`. |
| Key links | A titled list of links: external URLs, or Compass Docs. |
| Roadmap spotlight | Pinned public roadmap items with their status and planned dates. With nothing pinned it shows the latest public items that are Now. |
| Feedback | A submit button plus the top-voted ideas. |
| Recent updates | The latest public roadmap items that are Shipped or Launched. |
| Text block | Plain text, with a blank line between paragraphs. |

## What customers can never see

Visibility is enforced on the server, never by hiding things in the page.

- Roadmap widgets only ever return items that are on the public roadmap: not private, not archived, and only when **Public roadmap** is on. Pinning a private item does nothing for customers.
- The feedback widget follows the same rules as the public feedback page and is hidden when feedback is off.
- **Compass Docs are not public.** A Doc link is shown only to workspace members; customers do not receive it, even if you added it.
- Each widget has a **Visible to** setting: **Everyone** or **Signed-in customers**. A widget limited to signed-in customers is not sent to a signed-out visitor at all. **Specific segments** is stored but not available yet, so a widget set to it is shown to nobody.
- A widget whose surface is switched off or has nothing to show is left out for customers. In the editor it appears as hidden, with the reason.

## Known limits

- OKR and metric tiles are not available yet: key results are not public.
- The text block does not support formatting or embeds.
