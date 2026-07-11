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

Once enabled, your portal URLs are:

- **Feedback:** `/portal/[org]/[workspace]/feedback`
- **Public Roadmap:** `/portal/[org]/[workspace]/roadmap`

Share these links in your product, in onboarding emails, or in your documentation. By default, no login is required for visitors to submit or vote.

## Requiring Portal Accounts (Optional)

If you turn on **Require an account to submit/vote**, first-time visitors are asked to enter their email address and click **Send magic link**. Clicking the link they receive signs them in for that portal — their verified email becomes the identity attached to their feedback and votes, replacing the free-text email field. Once signed in, visitors see "Signed in as `<email>`" in the portal header with a **Sign out** option.

Portal accounts are completely separate from your team's Compass logins — a portal account can never access your internal workspace, OKRs, discovery data, or settings, regardless of what email address is used. There is no path from a portal account to a team member account; if a portal user is later invited to your workspace as a real team member, that invite creates an unrelated login with no connection to their prior portal activity.

## How Visitors Submit Feedback

Visitors to your feedback portal see a list of existing submissions sorted by vote count. They can:

- **Submit new feedback** by clicking **Share Feedback** — they provide a title and optional description
- **Vote on existing feedback** by clicking the upvote button on any submission. Each visitor can vote once per item (tracked by IP and session, or by portal account if account requirement is enabled)

Submissions automatically appear in your internal feedback triage view immediately.

## Triaging Feedback Internally

Inside Compass, the **Feedback** section shows all submitted feedback across your workspace. The internal view includes:

- Vote count and submission date
- The submitter's description
- A **Link to Opportunity** button that connects the feedback item to an existing opportunity in Discovery

Linking feedback to opportunities is how you turn raw customer voice into prioritised discovery work. An opportunity with ten linked feedback items has much stronger justification for investment than one based on a single interview.

## Keeping the Portal Fresh

The public feedback portal shows all submitted items, so quality matters. Internal team members can delete spam or off-topic submissions. For legitimate submissions that have been addressed via a shipped feature, you can mark them as closed — they'll still appear in the history but are visually distinguished from open items.
