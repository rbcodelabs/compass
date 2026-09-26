"use server";

/**
 * The first-party half of the widget's sign-in handoff.
 *
 * ## Why this is a server action and not a route under /api/embed/
 *
 * Every other endpoint in this feature is a public API route, because every other
 * endpoint is called cross-site by JavaScript running on a page Compass does not
 * serve. This one is the opposite: it runs on a Compass page, in a popup the
 * visitor can see the URL bar of, and it is the only step in the flow that reads
 * the portal session cookie.
 *
 * Making it an action rather than a route removes the two things a route would
 * have had to get right by hand. There is no CORS surface to configure — a server
 * action is same-origin by construction, and Next rejects a cross-origin POST to
 * one before this file runs. And there is no bespoke CSRF check to review: the
 * portal cookie is `SameSite=Lax`, so it does not accompany a cross-site POST
 * even as a top-level form submission.
 *
 * ## Two identities, chosen by the source and never by the request
 *
 * `FeedbackSource.authMode` decides which kind of sign-in this popup brokers:
 * `PORTAL` (an external reviewer, magic link, `PortalAccount`) or `INTERNAL_SSO`
 * (a Compass user who is a member of the workspace owning the source). The mode
 * comes off the resolved source row — the widget cannot ask to be treated as
 * internal, any more than it can ask which artifact its comments land on.
 *
 * ## The flow, and why only the PORTAL half polls
 *
 * 1. The widget draws a 32-byte nonce and opens this page with it.
 * 2. This action reports `signin_required` until the relevant session exists,
 *    naming the mode so the popup can render the right affordance.
 * 3. The visitor signs in. **This is where the two modes genuinely differ.**
 *
 *    PORTAL: the emailed link opens wherever their mail client sends it — a new
 *    tab, possibly a different window — so it can never redirect the popup back
 *    here. The cookie it sets is for the Compass origin, which is this popup's
 *    origin too, so the popup learns about it by asking again. That is the whole
 *    reason the client polls, and it is why no `returnTo` is involved on this
 *    path: `sanitizeReturnTo` in app/api/portal/auth/{send,verify} deliberately
 *    admits only `/portal/…`, and widening an open-redirect guard to reach a popup
 *    that cannot be redirected anyway would be a real risk taken for nothing.
 *
 *    INTERNAL_SSO: the login happens in this same window and comes back to this
 *    same URL, so **the poll is not needed** — the popup reloads already signed
 *    in. It is left running as a harmless fallback rather than removed, because it
 *    costs one metered read and covers the case of a session established in
 *    another tab. Critically, this needed **no guard widened**: `/login`'s
 *    `callbackUrl` is clamped to a same-origin root-relative path by
 *    `safeCallbackUrl` (lib/safe-callback-url.ts), and `/embed/signin` is already an
 *    exact-path public route in lib/route-access.ts — so a same-origin path
 *    round-trips as-is.
 * 4. Once signed in, this action deposits the handoff and the popup closes. The
 *    widget then claims the nonce for a scoped visitor token.
 *
 * Nothing claimable crosses back through this action's return value — see
 * lib/embed-visitor.ts. The token is minted at claim time, on the widget's own
 * authenticated request.
 */

import { auth } from "@/auth";
import { getPortalSession } from "@/lib/portal-auth";
import { EmbedSourceError, consumeEmbedRate, resolveEmbedToken } from "@/lib/embed-sources";
import { depositEmbedAuthHandoff } from "@/lib/embed-visitor";
import { isWorkspaceMember } from "@/lib/workspace";
import type { EmbedAuthMode } from "@/lib/embed-auth-mode";

export type EmbedSignInResult =
  /** The handoff is deposited. The widget's claim will now succeed exactly once. */
  | { status: "deposited"; email: string }
  /**
   * No usable session yet. `mode` tells the popup which affordance to render —
   * a magic-link form or an SSO link — and is why this carries a payload at all.
   */
  | { status: "signin_required"; mode: EmbedAuthMode }
  /**
   * Signed into Compass, but not a member of the workspace that owns this source.
   * Distinct from `signin_required` because signing in again cannot fix it, and
   * distinct from `unavailable` because nothing is broken. The email echoed back
   * is the reader's own, so naming it discloses nothing they do not know while
   * making "you are signed in as the wrong account" diagnosable.
   */
  | { status: "not_authorized"; email: string }
  /**
   * This popup cannot be completed at all: a bad, revoked, or disabled credential,
   * a malformed nonce, an unbound source, or a tripped quota. Carries a message
   * written for the visitor, because a thrown error would reach them as "An
   * unexpected error occurred" — Next redacts uncaught server-action messages in
   * production.
   */
  | { status: "unavailable"; error: string };

/**
 * The signed-in Compass user, or null if there is not a usable one.
 *
 * Exists to narrow NextAuth's optional session fields in one place. See the call
 * site in the INTERNAL_SSO branch for why both `id` and `email` are required.
 */
async function resolveSsoActor(): Promise<{ id: string; email: string } | null> {
  const user = (await auth())?.user;
  return user?.id && user.email ? { id: user.id, email: user.email } : null;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

/**
 * `token` is the source's embed token, the same `cmpfb_…` value the embedding page
 * carries in its script tag. It is passed here in the popup's URL, which is a
 * deliberate choice rather than an oversight: it is not a secret from the people
 * this popup is for, since anyone who can view the page it opened from can already
 * read it out of the DOM. What it buys is that this action can refuse a credential
 * that is fake, revoked, expired, or belongs to a disabled source before writing
 * anything — which a bare feedback-source id in a URL could not do, and which is
 * what keeps a stranger from depositing handoff rows against sources they have
 * nothing to do with.
 */
export async function depositEmbedSignIn(input: {
  token: string;
  nonce: string;
}): Promise<EmbedSignInResult> {
  // Hoisted out of the try so the duplicate-deposit branch in the catch can tell
  // which session to re-read. Null there means the failure happened at or before
  // token resolution, in which case there is no mode to speak of.
  let resolvedMode: EmbedAuthMode | null = null;
  try {
    const source = await resolveEmbedToken(input.token);
    resolvedMode = source.authMode;

    // Metered on the read bucket, and metered before the session check so a
    // signed-out poll is counted too. A popup polls every few seconds while the
    // visitor is off reading their email, which is well inside the 120/min read
    // ceiling but is not free, and an unmetered loop reachable by anyone holding a
    // public embed token is exactly the shape of an accidental amplifier.
    await consumeEmbedRate(source.tokenId, "READ");

    if (source.authMode === "INTERNAL_SSO") {
      // NextAuth types `user` and both of these fields as optional, so they are
      // narrowed once here rather than at each of the four uses below. `id` is the
      // authorization-bearing one — the membership check is the actual gate. `email`
      // is required too because every status this branch can return echoes it back
      // for display, and every provider configured here establishes a session from a
      // verified address, so a session with an id but no email is not a state this
      // app produces. Reading one as "sign in again" is the safe way to be wrong
      // about that: it withholds a deposit rather than granting one.
      const actor = await resolveSsoActor();
      if (!actor) return { status: "signin_required", mode: "INTERNAL_SSO" };

      // Membership in the workspace that owns this source — not merely "is signed
      // in", and not merely "has an allowed email domain". Those are both true of
      // every Compass user in the deployment, and this credential authorizes
      // writing into one workspace's artifact, so the narrower predicate is the
      // only one that matches what is being granted.
      //
      // Deliberately workspace membership rather than resolveWorkspaceAdmin's
      // predicate, which also admits org admins. See isWorkspaceMember.
      if (!(await isWorkspaceMember(source.workspaceId, actor.id))) {
        return { status: "not_authorized", email: actor.email };
      }

      // The write bucket is charged only for a real deposit. Charging it on every
      // poll would exhaust a 20/min submit quota in under a minute of waiting and
      // lock the visitor out of the flow they are in the middle of completing.
      await consumeEmbedRate(source.tokenId, "SUBMIT");

      await depositEmbedAuthHandoff({
        nonce: input.nonce,
        feedbackSourceId: source.sourceId,
        identity: { userId: actor.id },
      });

      return { status: "deposited", email: actor.email };
    }

    const identity = await getPortalSession();
    if (!identity) return { status: "signin_required", mode: "PORTAL" };

    // See above: SUBMIT is charged on deposit only, never on a poll.
    await consumeEmbedRate(source.tokenId, "SUBMIT");

    await depositEmbedAuthHandoff({
      nonce: input.nonce,
      feedbackSourceId: source.sourceId,
      identity: { portalAccountId: identity.portalAccountId },
    });

    return { status: "deposited", email: identity.email };
  } catch (error) {
    // A second deposit of the same nonce. The nonce is 32 CSPRNG bytes chosen by
    // one widget instance and never reused, so this is the same popup arriving
    // twice — two polls overlapping, or a double-mounted client — and not two
    // parties racing for one slot. Reported as success because the state the
    // caller asked for now holds.
    if (isUniqueViolation(error)) {
      if (resolvedMode === "INTERNAL_SSO") {
        const actor = await resolveSsoActor();
        if (actor) return { status: "deposited", email: actor.email };
      } else if (resolvedMode === "PORTAL") {
        const identity = await getPortalSession();
        if (identity) return { status: "deposited", email: identity.email };
      }
    }
    // Every EmbedSourceError in this path carries a message meant for a person: an
    // invalid credential, a disabled source, an unbound source, a tripped quota,
    // or a malformed nonce.
    if (error instanceof EmbedSourceError) {
      return { status: "unavailable", error: error.message };
    }
    console.error("[embed-signin] deposit failed", error);
    return { status: "unavailable", error: "Something went wrong. Please try again." };
  }
}
