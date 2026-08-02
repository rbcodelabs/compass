---
title: "Feedback Portal"
description: "Collect and triage customer feedback publicly with voting"
icon: "MessageSquare"
order: 5
section: "Core Features"
---

# Feedback Portal

The Feedback Portal gives your customers a public page to submit feature requests and bug reports, and to vote on what matters most to them. It connects directly to your internal Discovery workflow so feedback automatically informs opportunity prioritisation.

![Feedback portal](/screenshots/docs/feedback.png)

> 📸 Screenshot: run `pnpm docs:screenshots` with a `DOCS_SESSION_FILE` to capture this image.

## Enabling the Portal

The feedback portal is off by default. To enable it, go to **Settings → Portal** in your workspace. Toggle on:

- **Public Feedback Portal** — Enables the public submission and voting page
- **Public Roadmap** — Enables the public roadmap view showing your Now / Next / Later items
- **Require an account to submit/vote** — Once feedback or roadmap is enabled, an optional third toggle appears that requires visitors to verify their email via a magic link before they can submit feedback or vote
- **SSO Identify** — Once feedback or roadmap is enabled, an optional fourth toggle lets visitors arrive pre-verified from your own product instead of (or alongside) the magic-link flow — see below

Once enabled, your portal URLs are:

- **Feedback:** `/portal/[org]/[workspace]/feedback`
- **Public Roadmap:** `/portal/[org]/[workspace]/roadmap`

Share these links in your product, in onboarding emails, or in your documentation. By default, no login is required for visitors to submit or vote.

## Requiring Portal Accounts (Optional)

If you turn on **Require an account to submit/vote**, first-time visitors are asked to enter their email address and click **Send magic link**. Clicking the link they receive signs them in for that portal — their verified email becomes the identity attached to their feedback and votes, replacing the free-text email field. Once signed in, visitors see "Signed in as `<email>`" in the portal header with a **Sign out** option.

Portal accounts are completely separate from your team's Compass logins — a portal account can never access your internal workspace, OKRs, discovery data, or settings, regardless of what email address is used. There is no path from a portal account to a team member account; if a portal user is later invited to your workspace as a real team member, that invite creates an unrelated login with no connection to their prior portal activity.

## SSO Identify (Alternative to Magic-Link)

If your customers are already logged into your own product, making them re-verify their email via a magic link is unnecessary friction. **SSO Identify** lets your backend vouch for a visitor's identity directly:

1. In **Settings → Portal**, toggle on **SSO Identify** (only visible once feedback or roadmap is public), then click **Generate secret**. The raw shared secret is shown exactly once — copy it into your backend's config immediately. Compass stores it encrypted and can never show it to you again; if you lose it, click **Rotate secret** to generate a new one (this immediately invalidates the old one).
2. From your own backend, when a signed-in user clicks through to your Compass portal, mint a short-lived JSON Web Token (HS256, ≤5 minutes old) using that shared secret, with the payload `{ email, name?, iat, exp }`.
3. Send the user to `/api/portal/[org]/[workspace]/sso?token=<jwt>&returnTo=<path>`. Compass verifies the token, creates (or reuses) the matching portal account, signs the visitor in, and redirects to `returnTo` (must be a path under `/portal/...`) — or shows a simple "Signed in" confirmation if `returnTo` is omitted.

Any token that's unsigned, expired, older than 5 minutes, or missing a valid `email` claim is rejected. SSO Identify and the magic-link flow both produce the same kind of portal account and can be enabled together — visitors without an SSO link still fall back to email verification.

**v1 limitation:** rotating the secret has no grace period — the old secret stops working the instant you generate a new one. Coordinate the rotation with a backend deploy so there's no window where your backend is signing with a secret Compass no longer accepts.

## How Visitors Submit Feedback

Visitors to your feedback portal see a list of existing submissions sorted by vote count. They can:

- **Submit new feedback** by clicking **Share Feedback** — they provide a title and optional description
- **Vote on existing feedback** by clicking the upvote button on any submission. Each visitor can vote once per item (tracked by IP and session, or by portal account if account requirement is enabled)

Submissions automatically appear in your internal feedback triage view immediately.

## Attaching Screenshots & Files

When submitting feedback, visitors can attach files to help illustrate the issue or idea — a screenshot of a bug, a PDF, or a CSV of sample data. Supported file types are images (PNG, JPEG, GIF, WEBP), PDFs, and plain text/CSV files. Each file can be up to 10MB, with a maximum of 5 attachments per submission.

Attachments upload as soon as they're selected, showing a thumbnail (for images) or a file chip (for everything else) with a remove option before the submission is sent. Once submitted, attachments are visible both on the public portal listing and in the internal triage board, so your team can see exactly what the visitor saw.

## Submitting Feedback From Inside Compass

You don't have to wait for a customer submission to add something to the queue — your own team can log feedback directly, without going through the public portal:

- **On a workspace's Feedback board**, click **New Feedback** (also available from the empty state) to log an idea or bug against that workspace. It shows up in the board immediately, scoped just like a portal submission.
- **From anywhere in Compass** — any org, any workspace — open the account menu under your avatar (bottom of the sidebar on desktop, or **Account** in the mobile header) and choose **Send Feedback about Compass** to report a bug or suggest an improvement about Compass itself. This always lands in the Compass team's own workspace, regardless of which org or workspace you're currently working in, so it reaches the team no matter where you are.

Both flows attach your name and email automatically from your Compass login, so the team knows who to follow up with.

## Triaging Feedback Internally

Inside Compass, the **Feedback** section shows all submitted feedback across your workspace. The internal view includes:

- Vote count and submission date
- The submitter's description
- A **Link to Opportunity** button that connects the feedback item to an existing opportunity in Discovery

Linking feedback to opportunities is how you turn raw customer voice into prioritised discovery work. An opportunity with ten linked feedback items has much stronger justification for investment than one based on a single interview.

## Keeping the Portal Fresh

The public feedback portal shows all submitted items, so quality matters. Internal team members can delete spam or off-topic submissions. For legitimate submissions that have been addressed via a shipped feature, you can mark them as closed — they'll still appear in the history but are visually distinguished from open items.
