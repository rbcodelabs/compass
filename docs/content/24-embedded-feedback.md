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

## Who can comment

Each source picks one of two identities, and this is the setting worth thinking
about before you share a link:

**Your team, signed in with Compass SSO.** The reviewer signs in to Compass
normally and must be a **member of the workspace that owns the source**. Being
signed in is not sufficient, and neither is holding an allowed email domain.
Their comments are ordinary Compass comments with them as the author.

**External reviewers, by email link.** The reviewer enters an email address and
confirms it by clicking a link. Their comments are attributed to that verified
address rather than to a Compass account. Use this for customers, agencies, and
anyone who has no reason to have a Compass login.

Sign-in happens in a popup served by Compass, on the Compass origin, with the
Compass URL in a real address bar. The page the widget is embedded in never
sees the reviewer's email address or their sign-in link, and it cannot frame
that popup.

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
