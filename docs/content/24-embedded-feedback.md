---
title: "Embedded feedback"
description: "Collect element-anchored feedback from a prototype hosted outside Compass"
icon: "MessageSquarePlus"
order: 24
section: "Workspace"
---

# Embedded feedback

A prototype you host somewhere else — a Vercel preview, a staging site, a
one-off HTML page — can carry a comment button that files feedback straight
into Compass, anchored to the element the reviewer clicked.

You add one script tag. Compass supplies the button, the comment composer, and
the identity check.

## Set up a source

Go to **Settings → Embedded feedback** and press **New feedback source**. Each
source needs:

- **Name** — how you'll recognize it in this list, e.g. "Checkout prototype".
- **Prototype** — the artifact in this workspace that comments will attach to.
- **Who can comment** — see [Who can comment](#who-can-comment) below.
- **Allowed sites** — the exact origins permitted to use this source's token,
  e.g. `https://my-prototype.vercel.app`. Origins are matched exactly. There
  are no wildcards and no `*`, so a request from a site you didn't list is
  refused even if it holds a valid token.

Saving the source issues its first token and shows it once:

```html
<script src="https://your-compass-host/embed/widget.js" data-compass-token="cmpfb_…" defer></script>
```

Copy the token before dismissing the panel — it is stored only as a hash, so it
cannot be shown again. If you lose it, rotate the token rather than recreating
the source.

The snippet only appears when `NEXT_PUBLIC_APP_URL` is set for the deployment,
since the widget has to be loaded from an absolute URL.

## Agents and MCP

An agent that builds a prototype (for example v0) can wire the widget itself
with two MCP tools. Both are available to any workspace member and to registered
agents with write access, the same as `create_artifact`. (The Settings page
itself still requires a workspace admin.)

- `create_feedback_source` — `workspaceId`, `artifactId`, `name`,
  `allowedOrigins`, optional `authMode` (`INTERNAL_SSO` by default, or
  `PORTAL`). Returns the source id, the token (**shown once**), its prefix, the
  stored origins and a ready-to-paste snippet.
- `update_feedback_source` — `workspaceId`, `sourceId`, and any of
  `allowedOrigins` (the full replacement list), `enabled`, `name`,
  `authMode`. Returns the stored state. Changing `authMode` signs out
  existing visitors.

There is deliberately no delete, token-mint or token-revoke tool; those stay in
**Settings → Embedded feedback**.

The recipe, because the deploy origin is not known until after the first deploy:

1. `create_artifact` — register the prototype in Compass.
2. `create_feedback_source` with that artifact and a **provisional** origin
   (for example `http://localhost:3000`, or an empty list). Origins are exact;
   there are no wildcards.
3. Put the returned `snippet` in the prototype's root layout, then deploy.
4. `update_feedback_source` with the real deployed origin added to
   `allowedOrigins`. Until then the widget is refused on the deployed site.
5. `link_artifact_to_solution` — attach the artifact to the Solution it
   tests.

If the Compass deployment has no public URL configured, the response has no
`snippet`; it returns the token and `/embed/widget.js` path separately with a
note, and you build the script URL from your Compass host.

## Position and button style

By default the widget is a dark **Feedback** pill in the bottom-right corner.
Three optional attributes on the same script tag change where it sits and what
it looks like. They are cosmetic only — they never affect who can comment or
what is collected — and an unrecognised value falls back to the default (with a
console warning) instead of stopping the widget.

| Attribute | Values | Default |
| --- | --- | --- |
| `data-compass-position` | `bottom-right`, `bottom-left`, `top-right`, `top-left`, `right`, `left` | `bottom-right` |
| `data-compass-button` | `text`, `icon`, `tab` | `text` |
| `data-compass-label` | Any text, up to 24 characters | `Feedback` |

- **`text`** is the labelled pill.
- **`icon`** is a small round speech-bubble button. The label becomes its
  tooltip and accessible name, and the comment count still shows as a badge.
- **`tab`** is a slim vertical tab flush against a side edge of the screen. It
  takes its side from the position (`…-left` and `left` use the left edge,
  everything else the right) and its height from it too (`top-…` near the top,
  `bottom-…` near the bottom, `left` / `right` vertically centred).
- **`right`** and **`left`** hug that screen edge, vertically centred. The
  corner positions sit 20px in from the corner.

The feedback panel opens on the same side as the launcher, above or below a
corner button and beside a tab or an edge-centred button, so it never covers
the button that opened it.

```html
<!-- A small icon in the top-left corner -->
<script src="https://your-compass-host/embed/widget.js"
        data-compass-token="cmpfb_…"
        data-compass-position="top-left"
        data-compass-button="icon" defer></script>

<!-- A vertical "Give feedback" tab on the right edge -->
<script src="https://your-compass-host/embed/widget.js"
        data-compass-token="cmpfb_…"
        data-compass-position="right"
        data-compass-button="tab"
        data-compass-label="Give feedback" defer></script>
```

## Who can comment

Each source picks one of three identities, and this is the setting worth
thinking about before you share a link:

**Your team, signed in with Compass SSO.** The reviewer signs in to Compass
normally and must be a **member of the workspace that owns the source**. Being
signed in is not sufficient, and neither is holding an allowed email domain.
Their comments are ordinary Compass comments with them as the author.

**External reviewers, by email link.** The reviewer enters an email address and
confirms it by clicking a link. Their comments are attributed to that verified
address rather than to a Compass account. Use this for customers, agencies, and
anyone who has no reason to have a Compass login.

If this workspace also has **SSO Identify** configured (**Settings → Portal →
SSO Identify**), a source set to this mode can *also* skip the email link: the
host page passes the same JWT it already mints for its own portal integration,
either as `data-compass-sso-token` on the widget's script tag or by calling
`window.__compassFeedbackWidget.identify(jwt)`, and Compass exchanges it
directly for a signed-in reviewer — no popup, no cookie. The email link keeps
working alongside it; this is an optional shortcut for a returning visitor, not
a replacement.

**External reviewers, via SSO.** The same verified-email identity as the mode
above, but reached *only* through SSO Identify — there is no email link at
all for a source in this mode, so an integration must actually hand the
widget a JWT before anyone can comment. Requesting the emailed link is
refused outright rather than silently doing nothing. Choose this when your
own application already knows who the reviewer is on every page load and an
email fallback would just be an unused, unmonitored second path in.

This option is greyed out in the dropdown until this workspace has **SSO
Identify** configured (**Settings → Portal → SSO Identify**) — there being
nothing else that could ever sign a reviewer in for it.

Sign-in for the two email-capable modes happens in a popup served by Compass,
on the Compass origin, with the Compass URL in a real address bar. The page
the widget is embedded in never sees the reviewer's email address or their
sign-in link, and it cannot frame that popup. The SSO-only mode never opens
that popup at all — there is nothing for it to do.

## Who can read existing feedback

By default, only a Compass user who is a member of this workspace can read the
existing thread through the widget. Your own team reading it therefore works
without changing anything, while an external reviewer can add a comment without
being shown what everyone else said.

The **Let anyone with the embed code read existing feedback** toggle widens
that: with it on, anyone who can load a page carrying one of this workspace's
embed tokens can read every comment on the anchored artifact. Since the token
is visible in the page source of any site you've embedded it in, treat this as
publishing the thread to everyone who can reach that site.

## Rotating and revoking tokens

A source can hold several tokens at once, which is what makes rotation
non-disruptive: issue a new token, update the embedded sites, then revoke the
old one. A revoked token stops working immediately.

Tokens do not expire on their own. A deployed prototype has no natural expiry
date, so revocation is the kill switch rather than a timeout.

Turning a source off with its **Enable** switch refuses every token it holds
without revoking any of them, which is the quicker move when you just want the
button to stop appearing.

## What reviewers can leave

Pressing the comment button lets the reviewer pick an element on the page and
write a comment against it. Compass records the page URL and path, a selector
and fingerprint for the element, and — when the browser allows it — a
screenshot of the element as an aid to whoever reads the thread later.

Comments arrive on the artifact you bound the source to and can be read there
like any other comment. The element context is stored with each comment and is
served back to the widget, so a reviewer returning to the prototype sees the
existing thread in place, and Compass's own artifact viewer renders the same
anchors as pins over the artifact (falling back to a "could not be
re-anchored" notice rather than a misplaced pin when the page has changed too
much to re-locate the element confidently).

This widget only runs on a prototype hosted at your own `https://` origin. For
an HTML file you uploaded directly into Compass, use the native picker built
into the artifact viewer instead — no script tag or token needed, since it
runs in the same page as your Compass session. See
[Artifact feedback](/help/25-artifact-feedback).
