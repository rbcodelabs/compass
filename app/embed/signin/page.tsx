/**
 * The widget's sign-in popup.
 *
 * Opened by `window.open` from a page Compass does not serve, which is the entire
 * point of it: the visitor's email address and their magic link are handled on the
 * Compass origin, with the Compass URL in a real address bar, and the embedding
 * page never sees either. next.config.ts refuses to let this page be framed for
 * the same reason — a sign-in screen the operator of the surrounding page could
 * wrap is not a sign-in screen the visitor can trust, and it also sends no
 * referrer, because this URL carries the handoff nonce.
 *
 * Both query parameters are checked for shape here, before anything touches the
 * database. `assertWellFormedNonce` in lib/embed-visitor.ts is the real gate and
 * runs again server-side; this one exists so a visitor who lands on a mangled URL
 * gets an explanation instead of a spinner over a doomed poll.
 *
 * This is also where the internal-SSO entry href is built, from the two parameters
 * this page has just shape-checked rather than from anything the popup would have to
 * re-derive on the client. It is computed unconditionally rather than only for an
 * INTERNAL_SSO source: the mode is not known until the action has resolved the
 * token, and passing a string the popup may never render is cheaper than a second
 * round trip. The href is not a capability — following it signs the visitor into
 * their own account or nothing.
 */
import type { Metadata } from "next";
import { EMBED_TOKEN_PREFIX } from "@/lib/embed-sources";
import { EmbedSignInPopup } from "./signin-popup";

/** A transient popup on a public path. Nothing here belongs in a search index. */
export const metadata: Metadata = {
  title: "Sign in to leave feedback",
  robots: { index: false, follow: false },
};

const NONCE_RE = /^[0-9a-f]{64}$/;

type Props = {
  searchParams: Promise<{ token?: string; nonce?: string }>;
};

export default async function EmbedSignInPage({ searchParams }: Props) {
  const { token, nonce } = await searchParams;

  const wellFormed =
    typeof token === "string" &&
    token.startsWith(EMBED_TOKEN_PREFIX) &&
    typeof nonce === "string" &&
    NONCE_RE.test(nonce);

  if (!wellFormed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 py-10">
        <div className="rounded-xl border border-border bg-card p-5">
          <h1 className="mb-2 text-base font-semibold">This sign-in link is incomplete</h1>
          <p className="text-sm text-muted-foreground">
            Close this window and press the comment button on the page you came from to start again.
          </p>
        </div>
      </main>
    );
  }

  return <EmbedSignInPopup token={token} nonce={nonce} ssoHref={buildSsoHref(token, nonce)} />;
}

/**
 * Where an internal visitor goes to sign in, and back to.
 *
 * No guard has to be widened to carry this round trip. `callbackUrl` goes through
 * `safeCallbackUrl` (lib/safe-callback-url.ts), which accepts a root-relative path
 * unchanged and rejects anything absolute or protocol-relative; the value built
 * below is a root-relative path on this app's own origin; and `/embed/signin` is
 * already an exact-path public route in lib/route-access.ts, so the visitor lands
 * back on this popup with a session rather than on another redirect.
 *
 * Both parameters are re-validated on the way back in, by the same shape checks
 * above and by the action itself — nothing here is trusted on return merely because
 * it was emitted here.
 */
function buildSsoHref(token: string, nonce: string): string {
  const returnTo = `/embed/signin?token=${encodeURIComponent(token)}&nonce=${encodeURIComponent(nonce)}`;
  return `/login?callbackUrl=${encodeURIComponent(returnTo)}`;
}
