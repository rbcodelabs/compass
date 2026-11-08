---
title: "Portal home"
description: "Build the customer portal's home page from widgets and a template: announcements, docs, key links, roadmap spotlight, feedback and recent updates"
icon: "LayoutDashboard"
order: 28
section: "Core Features"
---

# Portal home

The **portal home** is the first page customers see at `/portal/[org]/[workspace]`. That page is public: signed-out visitors can open it (unless you require portal sign-in). It is a board of widgets that you arrange and publish yourself. Until you publish a layout, customers see a sensible default: a welcome announcement, the roadmap, recently shipped work, and a feedback prompt, each shown only if the matching portal surface is switched on.

## Templates

A **template** decides how the same widgets are laid out; it never changes which widgets or data customers can see. Choose one under **Edit home**, in the **Template** picker above the board. The editor canvas re-arranges immediately, and, like widget changes, a template change stays a draft until you **Publish**. Customers keep seeing the published template until then.

| Template | Look |
|---|---|
| Editorial (default) | A calm, centred page: a large heading, a short tagline, **View the roadmap** and **Share feedback** buttons, and a one-line summary such as "Updated Nov 5, 2026 · 6 items in progress · 4 published docs". Widgets stack in a single readable column. |
| Bento | A brand-coloured header with the widgets as a grid of tiles that overlap it. Widget size (S, M, L) sets the tile width. |
| Shell | A sidebar for navigation with the widgets in the main area. On a phone the sidebar becomes a menu drawer. |
| Docs hub | A dark, search-first header ("How can we help?") with a search box and quick-search chips, then your docs as colour-tinted cards. The announcement comes first, then Docs; link lists and the feedback prompt move to a side rail. |

![The Editorial template with an announcement, Docs, key links, roadmap and recent updates](/screenshots/docs/portal-home-template-editorial.png)

![The Docs hub template](/screenshots/docs/portal-home-template-docs-hub.png)

Details worth knowing:

- Every figure in the Editorial summary line is real and public: the date of the latest change to a public roadmap item or published doc, the number of public roadmap items on **Now**, and the number of published docs. A figure that would be zero, or that comes from a surface the portal does not show (the roadmap when **Public roadmap** is off, docs when the home has no Docs widget), is left out; with nothing to show, the line is omitted.
- The **Popular** chips in the Docs hub are your most recently published doc titles. Compass has no usage data, so they are not ranked by popularity. Selecting a chip filters the docs on the page. The search box filters the docs shown on the home as you type; it does not search the roadmap.
- The hero (heading, buttons, search) appears on the home page only. Roadmap and feedback pages keep the template's header and footer.
- Every template follows the visitor's light or dark setting.

## The team home

Your team sees the same home, in the same layout, from the **Home** tab in the sidebar (`/[org]/[workspace]/home`). It is only available to workspace members. Anyone else is sent to sign in or gets a not-found page.

The team home shows every widget that is **Everyone**, **Signed-in customers** or **Team only**, so members see a superset of what customers see. Doc links in a Key links widget appear here too. Widgets set to **Specific segments** stay hidden. Like the customer page, it shows the **published** layout. Admins also get the **Edit home** bar on this page, and the draft is only visible there until published. Editing on either page changes the one shared layout.

The team home shows **internal data**, not just what is public. Roadmap widgets include **private** roadmap items (anything not archived), Recent updates lists everything Shipped or Launched, and the Feedback widget shows the top ideas (everything except declined ideas). None of this depends on **Public roadmap** or **Feedback** being switched on. Links on the team home go to the in-app Roadmap and Feedback pages, not the customer portal. A widget with nothing to show is left out. **Customers never see any of this**: the customer home keeps the public rules described under "What customers can never see".

In the editor, each widget shows the team's data and a separate **Not shown to customers: reason** badge whenever customers will not get it (the portal surface is off, nothing public to show, or the widget is **Team only**). That verdict comes from the real customer rules. You can pin private items in a Roadmap spotlight; they are labeled **Private** in the picker, and customers will not see them.

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
| Docs | Docs you have published to the portal, newest first, each with its title, a short excerpt and the date it was last updated, plus a **Browse all docs** link. Choose **All published docs** or **Selected docs** (pick up to 12 and set their order), and a maximum to show. The layout follows the template: rows with the date right-aligned in Editorial, tinted cover cards in the Docs hub. Only published docs are ever shown; a selected doc that is not published is skipped. |
| Roadmap spotlight | Pinned public roadmap items with their status and planned dates. With nothing pinned it shows the latest public items that are Now. |
| Feedback | A submit button plus the top-voted ideas. |
| Recent updates | The latest public roadmap items that are Shipped or Launched. |
| Text block | Plain text, with a blank line between paragraphs. |

## What customers can never see

Visibility is enforced on the server, never by hiding things in the page.

- Roadmap widgets only ever return items that are on the public roadmap: not private, not archived, and only when **Public roadmap** is on. Pinning a private item does nothing for customers.
- The feedback widget follows the same rules as the public feedback page and is hidden when feedback is off.
- **Docs are public only once you publish them.** A Doc link in Key links, and any entry in the Docs widget, reaches customers only if that doc is published to the portal (see [Docs](/help/06-docs)); an unpublished doc is dropped for customers even if you added it. Workspace members still see every Doc link on the team home. Published docs are readable by anyone with the portal link, including when **Require portal sign-in** is on: that setting protects the roadmap and feedback pages, not docs. Unpublish a doc to remove it immediately.
- **The Docs widget disappears when there is nothing to show.** If no doc is published (or none of the selected docs are), customers see no Docs widget and the Docs hub shows no Popular chips. (The **Docs** navigation link follows the widget being on the home, so it still opens the Docs page, which then says nothing is published yet.) The editor shows a **Not shown to customers** badge explaining why, and the team home explains it too.
- Each widget has a **Visible to** setting: **Everyone**, **Signed-in customers** or **Team only**. A widget limited to signed-in customers is not sent to a signed-out visitor at all. A **Team only** widget is shown on the team home and is never sent to any customer, signed in or not: it is removed on the server before anything is looked up for it. **Specific segments** is stored but not available yet, so a widget set to it is shown to nobody.
- A widget whose surface is switched off or has nothing to show is left out for customers. In the editor it carries the **Not shown to customers** badge, with the reason.

## Known limits

- OKR and metric tiles are not available yet: key results are not public.
- The text block does not support formatting or embeds.
