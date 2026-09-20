/**
 * OAuth authorization + consent functional spec.
 *
 * Journey: an MCP client registers itself through open Dynamic Client
 * Registration, opens `/oauth/authorize` in a **fresh, signed-out browser**
 * (which is the normal case, not the edge case — an MCP client launches a new
 * browser), gets bounced through `/login` and back, reads the consent screen,
 * and either approves or declines.
 *
 * Every assertion here maps to a decision recorded in
 * `docs/design/mcp-oauth-discovery.md`, and each one is load-bearing rather
 * than descriptive:
 *
 *  - **The query string survives `/login`.** An authorize request is *entirely*
 *    query string. Losing it was the exact blocker `ad04274` fixed, and the
 *    failure is silent — the user lands on a dashboard and the client hangs.
 *  - **The org/workspace enumeration renders.** Decision 1 removed the
 *    workspace picker, so the grant spans every membership the user has across
 *    every org. Naming them is the *only* compensating control; if it silently
 *    stops rendering, "Connect Compass" reads like one workspace and is in fact
 *    all of them.
 *  - **The unverified marking renders.** Registration is open and there are no
 *    verified clients, so `client_name` is attacker-chosen — both clients this
 *    spec registers call themselves "Compass Official …" precisely to prove the
 *    screen never treats a name as an endorsement. The marking, and the
 *    redirect target beside it, are the only unforgeable signals on the page.
 *  - **Deny issues nothing.** Asserted twice — once on the redirect the client
 *    receives, once against `oauth_authorization_codes` directly — because a
 *    code that is issued but not delivered is still a code.
 *  - **`iss` comes back (RFC 9207).** The AS metadata advertises
 *    `authorization_response_iss_parameter_supported`, and a client that trusts
 *    that flag rejects a response without it. The expected value is read from
 *    the live metadata document rather than hardcoded, so the assertion is a
 *    real consistency check instead of a restatement of the config.
 *
 * ## Why there are two registered clients
 *
 * The consent screen's redirect-target copy branches on whether the redirect
 * URI is loopback, and the two branches are the two real client shapes:
 *
 *  - **Hosted** (`https://…`, what Claude registers) names the bare host —
 *    "Access will be handed to …". That is the branch where "show the
 *    redirect_uri host" literally happens, so it gets the content assertions.
 *  - **Loopback** (`http://127.0.0.1:…`, what the Geode broker and every native
 *    client register, RFC 8252 §7.3) instead warns that the software is running
 *    on your own machine.
 *
 * Approve and deny run against the loopback client because those steps have to
 * observe where the browser is genuinely *sent*. A real `http.Server` on an
 * ephemeral loopback port is what a native client actually stands up, so the
 * callback is received exactly as one would receive it — and, unlike a
 * Playwright-intercepted route, a navigation to it resolves instead of dying at
 * DNS. Nothing leaves the machine.
 */
import { test, expect } from "../fixtures/index";
import type { APIRequestContext, Page } from "@playwright/test";
import http from "node:http";
import { AddressInfo } from "node:net";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";

/** Names no user should read as an endorsement — see the unverified assertions. */
const HOSTED_CLIENT_NAME = "Compass Official Sync";
const LOOPBACK_CLIENT_NAME = "Compass Official Desktop";
const HOSTED_CALLBACK_HOST = "oauth-e2e.example.com";
const HOSTED_REDIRECT_URI = `https://${HOSTED_CALLBACK_HOST}/callback`;
const REQUESTED_SCOPE = "mcp:read mcp:write offline_access";
const DEV_USER_EMAIL = "dev@localhost.dev";
/** Kept in sync with CONSENT_COOKIE_NAME in lib/oauth/consent.ts. */
const CONSENT_COOKIE_NAME = "__Host-compass_oauth_consent";

/** Mirrors globalSetup's schema resolution (`compass_dev`, or `<PGSCHEMA>_dev`). */
const SCHEMA = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh PKCE pair and `state` per authorization request. */
function newAuthorizationParams() {
  const codeVerifier = base64Url(randomBytes(32));
  return {
    codeChallenge: base64Url(createHash("sha256").update(codeVerifier).digest()),
    state: `e2e-state-${randomBytes(8).toString("hex")}`,
  };
}

function authorizeQuery(clientId: string, redirectUri: string, state: string, codeChallenge: string) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: REQUESTED_SCOPE,
  });
}

/** Registers a client through the real, unauthenticated DCR endpoint. */
async function registerClient(
  request: APIRequestContext,
  clientName: string,
  redirectUri: string
): Promise<string> {
  const response = await request.post("/api/oauth/register", {
    headers: { "content-type": "application/json" },
    data: {
      client_name: clientName,
      redirect_uris: [redirectUri],
      scope: REQUESTED_SCOPE,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    },
  });
  expect(
    response.status(),
    `DCR must accept an unauthenticated registration for ${clientName}`
  ).toBe(201);
  const registered = await response.json();
  expect(registered.client_id, "DCR must return a client_id").toBeTruthy();
  expect(registered.client_name).toBe(clientName);
  return registered.client_id;
}

async function codeCount(pool: pg.Pool, clientId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${SCHEMA}".oauth_authorization_codes WHERE client_id = $1`,
    [clientId]
  );
  return Number(rows[0].count);
}

/**
 * Waits for the browser to land on the loopback callback.
 *
 * Deliberately compares `origin`, not a substring: the authorize URL the
 * browser is already on carries the callback origin inside its own
 * `redirect_uri` parameter, so a substring match resolves instantly against the
 * page we were trying to navigate away from — and every downstream assertion
 * then reads parameters off the wrong URL.
 */
async function waitForCallback(page: Page, callbackOrigin: string): Promise<URL> {
  await page.waitForURL((url) => url.origin === callbackOrigin, { timeout: 30_000 });
  return new URL(page.url());
}

test("an MCP client registers, survives the login bounce, and the consent screen governs what it gets", async ({
  browser,
  baseURL,
  request,
}) => {
  // Two client registrations and three consent round trips through a
  // cold-compiling Next dev server; the suite's 90s default is not enough for
  // the first one.
  test.setTimeout(180_000);

  const databaseUrl = new URL(process.env.DATABASE_URL!);
  if (
    !["localhost", "127.0.0.1"].includes(databaseUrl.hostname) ||
    databaseUrl.pathname !== "/compass_e2e"
  ) {
    throw new Error("OAuth consent tests require the dedicated local compass_e2e database");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl.toString() });

  // The native client's callback listener, exactly as RFC 8252 §7.3 describes:
  // an ephemeral port on loopback, bound before registration so the port can be
  // registered. It only ever has to answer 200 — the assertions read the URL.
  const callbackServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><body>e2e callback received</body></html>");
  });
  await new Promise<void>((resolve) => callbackServer.listen(0, "127.0.0.1", resolve));
  const callbackPort = (callbackServer.address() as AddressInfo).port;
  const loopbackOrigin = `http://127.0.0.1:${callbackPort}`;
  const loopbackRedirectUri = `${loopbackOrigin}/cb`;

  const registeredClientIds: string[] = [];

  try {
    // ── 0. The issuer this deployment will stamp into `iss`, read from the
    //       live RFC 8414 document rather than hardcoded. ───────────────────
    const metadataResponse = await request.get("/.well-known/oauth-authorization-server");
    expect(metadataResponse.status(), "AS metadata must be served").toBe(200);
    const metadata = await metadataResponse.json();
    const expectedIssuer: string = metadata.issuer;
    expect(expectedIssuer, "AS metadata must advertise an issuer").toBeTruthy();
    expect(
      metadata.authorization_response_iss_parameter_supported,
      "RFC 9207 support is advertised, so every response must carry iss"
    ).toBe(true);

    // ── 1. Dynamic Client Registration (RFC 7591) — unauthenticated, which is
    //       the design: registration happens before any user is involved. ────
    //       Each id is recorded the moment it exists, so a failure in the
    //       second registration still leaves the first one cleanable.
    const hostedClientId = await registerClient(request, HOSTED_CLIENT_NAME, HOSTED_REDIRECT_URI);
    registeredClientIds.push(hostedClientId);
    const loopbackClientId = await registerClient(
      request,
      LOOPBACK_CLIENT_NAME,
      loopbackRedirectUri
    );
    registeredClientIds.push(loopbackClientId);

    const hosted = newAuthorizationParams();
    const hostedQuery = authorizeQuery(
      hostedClientId,
      HOSTED_REDIRECT_URI,
      hosted.state,
      hosted.codeChallenge
    );
    const hostedAuthorizePath = `/oauth/authorize?${hostedQuery.toString()}`;

    // Every step below runs in a browser that has never signed in — an MCP
    // client opens a fresh browser, so this is the normal path.
    const anonContext = await browser.newContext({ storageState: undefined });
    try {
      // ── 2. Signed-out GET redirects to /login with the query string intact.
      //       Asserted parameter by parameter: a redirect that reaches /login
      //       having dropped `code_challenge` still *looks* like it worked. ──
      await test.step("signed-out authorize redirects to /login with every OAuth parameter preserved", async () => {
        const redirected = await anonContext.request.get(hostedAuthorizePath, { maxRedirects: 0 });
        expect(
          [302, 303, 307, 308],
          `expected a redirect to /login, got HTTP ${redirected.status()}`
        ).toContain(redirected.status());

        const location = redirected.headers()["location"];
        expect(location, "the redirect must carry a Location header").toBeTruthy();
        const loginUrl = new URL(location, baseURL);
        expect(loginUrl.pathname).toBe("/login");

        const callbackUrl = loginUrl.searchParams.get("callbackUrl");
        expect(callbackUrl, "/login must be given a callbackUrl").toBeTruthy();
        const returnTo = new URL(callbackUrl!, baseURL);
        expect(returnTo.pathname).toBe("/oauth/authorize");

        for (const [key, value] of hostedQuery.entries()) {
          expect(
            returnTo.searchParams.get(key),
            `OAuth parameter "${key}" must survive the login redirect`
          ).toBe(value);
        }
      });

      // ── 3. The clickjacking defences the design requires on the surface that
      //       grants access. Framed inside an attacker's page, "Allow access"
      //       can be positioned under an innocuous button. ───────────────────
      await test.step("the consent surface sends X-Frame-Options: DENY and frame-ancestors 'none'", async () => {
        const headerProbe = await anonContext.request.get(hostedAuthorizePath, { maxRedirects: 0 });
        const headers = headerProbe.headers();
        expect(headers["x-frame-options"]).toBe("DENY");
        expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      });

      const anonPage = await anonContext.newPage();

      // ── 4. The bounce, end to end: authorize → login → back to consent. ───
      await test.step("signing in returns the user to the consent screen, not the dashboard", async () => {
        await anonPage.goto(hostedAuthorizePath);
        await expect(anonPage).toHaveURL(/\/login\?/);
        await expect(
          anonPage.getByRole("heading", { name: "Sign in to Compass", exact: true })
        ).toBeVisible();

        await anonPage.getByRole("button", { name: /Dev Login/i }).click();
        await anonPage.waitForURL(/\/oauth\/authorize\?/, { timeout: 60_000 });

        // Not just the path — the parameters have to have survived the sign-in
        // too, or the screen below would be describing a different grant.
        const landed = new URL(anonPage.url());
        expect(landed.searchParams.get("state")).toBe(hosted.state);
        expect(landed.searchParams.get("code_challenge")).toBe(hosted.codeChallenge);

        // Before asserting on copy: prove the page actually rendered. The
        // consent screen reads every membership the user holds, and a single
        // orphaned `workspace_members` row (there are no FKs —
        // relationMode="prisma") makes `grantedOrganizations` dereference a
        // null relation and 500. Without this check that failure surfaces as
        // "heading not found", which reads like a copy change rather than a
        // dead authorize endpoint.
        const rendered = await anonPage.reload();
        expect(
          rendered?.status(),
          "the consent screen must render; a 500 here means the authorize endpoint is down"
        ).toBe(200);
      });

      // ── 5. Everything the screen is obliged to say. ───────────────────────
      await test.step("the consent screen names the client, the redirect host, the scopes and every org and workspace", async () => {
        await expect(
          anonPage.getByRole("heading", { name: `Authorize ${HOSTED_CLIENT_NAME}` })
        ).toBeVisible();
        await expect(anonPage.getByText(DEV_USER_EMAIL)).toBeVisible();

        // Unforgeable, unlike the name above it: the full URI, and the bare
        // host in the sentence that tells the user where access actually goes.
        await expect(anonPage.getByText(HOSTED_REDIRECT_URI)).toBeVisible();
        await expect(
          anonPage.getByText(`Access will be handed to ${HOSTED_CALLBACK_HOST}`, { exact: false })
        ).toBeVisible();

        // Every requested scope described in plain language. A scope with no
        // copy would understate the grant, which is the failure this screen
        // exists to prevent.
        await expect(anonPage.getByText(/Read your opportunities, solutions/i)).toBeVisible();
        await expect(anonPage.getByText(/Create and change that same data/i)).toBeVisible();
        await expect(
          anonPage.getByText(/Stay connected without asking you to sign in again/i)
        ).toBeVisible();

        // The compensating control for there being no workspace picker.
        await expect(
          anonPage.getByRole("heading", { name: /Where it will have access/i })
        ).toBeVisible();
        await expect(anonPage.getByText(/E2E Test Org/)).toBeVisible();
        await expect(anonPage.getByText("E2E Workspace", { exact: true })).toBeVisible();
        await expect(anonPage.getByText("E2E Planning", { exact: true })).toBeVisible();

        // …and it must not undercount. A summary that says "1 workspace" while
        // granting four is worse than no summary at all, so the number is
        // checked against the memberships the database actually holds.
        const summaryLine = anonPage.getByText(
          /Everything you can reach — \d+ organizations? and \d+ workspaces?/
        );
        await expect(summaryLine).toBeVisible();
        const listedWorkspaces = Number((await summaryLine.innerText()).match(/and (\d+) workspaces?/)![1]);
        const seeded = await pool.query<{ workspaces: string }>(
          `SELECT COUNT(*)::text AS workspaces
             FROM "${SCHEMA}".workspace_members m
             JOIN "${SCHEMA}".users u ON u.id = m.user_id
            WHERE u.email = $1`,
          [DEV_USER_EMAIL]
        );
        expect(
          listedWorkspaces,
          "the consent screen must enumerate every workspace membership the user actually holds"
        ).toBe(Number(seeded.rows[0].workspaces));
      });

      await test.step("the client is visibly marked unverified despite calling itself official", async () => {
        await expect(anonPage.getByText("Unverified application")).toBeVisible();
        await expect(
          anonPage.getByText(/Compass does not review or verify the applications/i)
        ).toBeVisible();
      });

      await test.step("rendering the consent screen writes no approval cookie", async () => {
        // The design requires the consent cookie be set only *after* an explicit
        // approval, so a drive-by GET — an <img> tag, a prefetch, a link in an
        // email — cannot plant state a later request would honour as consent.
        const cookies = await anonContext.cookies();
        expect(
          cookies.map((cookie) => cookie.name),
          "a GET of /oauth/authorize must not write the consent cookie"
        ).not.toContain(CONSENT_COOKIE_NAME);
      });

      // ── 6. Deny first — deliberately before approve, because approving
      //       records consent and a later authorize would skip the screen
      //       entirely and auto-issue a code. ───────────────────────────────
      const denied = newAuthorizationParams();
      await test.step("declining returns access_denied to the client and issues no authorization code", async () => {
        await anonPage.goto(
          `/oauth/authorize?${authorizeQuery(loopbackClientId, loopbackRedirectUri, denied.state, denied.codeChallenge)}`
        );
        await expect(
          anonPage.getByRole("heading", { name: `Authorize ${LOOPBACK_CLIENT_NAME}` })
        ).toBeVisible();
        // The loopback branch of the unverified notice — still marked, with
        // copy matched to software running on the user's own machine.
        await expect(anonPage.getByText("Unverified application")).toBeVisible();
        await expect(
          anonPage.getByText(/This is software running on your own computer/i)
        ).toBeVisible();
        await expect(anonPage.getByText(loopbackRedirectUri)).toBeVisible();

        await anonPage.getByRole("button", { name: "Cancel" }).click();
        const callback = await waitForCallback(anonPage, loopbackOrigin);

        expect(callback.searchParams.get("error")).toBe("access_denied");
        expect(callback.searchParams.get("state")).toBe(denied.state);
        expect(callback.searchParams.get("iss")).toBe(expectedIssuer);
        expect(
          callback.searchParams.get("code"),
          "a declined request must not carry a code"
        ).toBeNull();

        // A code that is issued but never delivered is still a code.
        expect(
          await codeCount(pool, loopbackClientId),
          "declining must not write an authorization code"
        ).toBe(0);
      });

      // ── 7. Approve. ──────────────────────────────────────────────────────
      const approved = newAuthorizationParams();
      await test.step("approving redirects to the registered redirect_uri with code, state and iss", async () => {
        await anonPage.goto(
          `/oauth/authorize?${authorizeQuery(loopbackClientId, loopbackRedirectUri, approved.state, approved.codeChallenge)}`
        );
        await expect(
          anonPage.getByRole("heading", { name: `Authorize ${LOOPBACK_CLIENT_NAME}` })
        ).toBeVisible();

        await anonPage.getByRole("button", { name: "Allow access" }).click();
        const callback = await waitForCallback(anonPage, loopbackOrigin);

        expect(
          callback.origin + callback.pathname,
          "the code must be delivered to the registered redirect_uri, unchanged"
        ).toBe(loopbackRedirectUri);
        expect(callback.searchParams.get("code"), "approval must deliver a code").toBeTruthy();
        expect(callback.searchParams.get("state"), "state must be echoed back intact").toBe(
          approved.state
        );
        expect(
          callback.searchParams.get("iss"),
          "RFC 9207 iss must match the issuer the AS metadata advertises"
        ).toBe(expectedIssuer);
        expect(callback.searchParams.get("error")).toBeNull();

        expect(
          await codeCount(pool, loopbackClientId),
          "approval must write exactly one authorization code"
        ).toBe(1);
      });
    } finally {
      await anonContext.close();
    }
  } finally {
    for (const clientId of registeredClientIds) {
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_authorization_codes WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_tokens WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_consents WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_clients WHERE client_id = $1`, [clientId]);
    }
    await pool.end();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
});
