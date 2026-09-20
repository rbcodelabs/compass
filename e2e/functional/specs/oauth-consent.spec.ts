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
 *  - **The binding picker governs what the token becomes.** ADR 0015: the screen
 *    asks which identity the connection acts as, and the answer is asserted
 *    where it actually matters — on the exchanged token's `get_current_identity`
 *    result, not on the radio button. A perfect picker that writes
 *    `authorization_mode = 'USER'` is the silent no-op the whole change exists
 *    to avoid.
 *  - **A zero-reach selection cannot be approved.** An agent with no grants
 *    yields a token that authenticates, passes every gate, and then fails every
 *    call with "Workspace not found or access denied." The design calls this the
 *    requirement most likely to be quietly dropped under time pressure, so it is
 *    asserted on the live button rather than in a unit test alone.
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
import { mkdir } from "node:fs/promises";

/** Names no user should read as an endorsement — see the unverified assertions. */
const HOSTED_CLIENT_NAME = "Compass Official Sync";
const LOOPBACK_CLIENT_NAME = "Compass Official Desktop";
const HOSTED_CALLBACK_HOST = "oauth-e2e.example.com";
const HOSTED_REDIRECT_URI = `https://${HOSTED_CALLBACK_HOST}/callback`;
const REQUESTED_SCOPE = "mcp:read mcp:write offline_access";
const DEV_USER_EMAIL = "dev@localhost.dev";
/**
 * Retired by ADR 0015 and asserted as *absent*. A 90-day signed approval cookie
 * is a second source of truth no server-side migration can revoke, which would
 * have let an already-consented browser skip the binding screen entirely.
 */
const RETIRED_CONSENT_COOKIE_NAME = "__Host-compass_oauth_consent";
/** Named so the teardown can find them however the run fails. */
const SEEDED_AGENT_NAME = "E2E OAuth Seeded Agent";
const INLINE_AGENT_NAME = "E2E OAuth Inline Agent";

/** Mirrors globalSetup's schema resolution (`compass_dev`, or `<PGSCHEMA>_dev`). */
const SCHEMA = process.env.PGSCHEMA ? `${process.env.PGSCHEMA}_dev` : "compass_dev";

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh PKCE pair and `state` per authorization request. */
function newAuthorizationParams() {
  const codeVerifier = base64Url(randomBytes(32));
  return {
    codeVerifier,
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

/** Visual QA evidence only; the consent page contains no code or bearer token. */
async function captureConsentScreenshots(page: Page): Promise<void> {
  const originalViewport = page.viewportSize() ?? { width: 1280, height: 800 };
  await mkdir("test-results/oauth-qa", { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({
    path: "test-results/oauth-qa/consent-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/oauth-qa/consent-mobile.png",
    animations: "disabled",
  });
  await page.setViewportSize(originalViewport);
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

        // Still the compensating control, but now for the *binding's* reach
        // rather than for every membership — under an agent binding the old
        // enumeration would overstate the grant, which is the one failure this
        // screen exists to prevent.
        await expect(
          anonPage.getByRole("heading", { name: /Where it will have access/i })
        ).toBeVisible();
        await expect(anonPage.getByText(/E2E Test Org/).first()).toBeVisible();
        await expect(anonPage.getByText(/E2E Workspace/).first()).toBeVisible();
        await expect(anonPage.getByText(/E2E Planning/).first()).toBeVisible();

        // Captured before approval: browser chrome is not part of Playwright's
        // page screenshot, and no authorization code or bearer token exists yet.
        await captureConsentScreenshots(anonPage);
      });

      // ── 5b. The binding section, which is the whole of ADR 0015 stage 2. ──
      await test.step("the screen asks which identity the connection will act as", async () => {
        await expect(anonPage.getByText("Act as", { exact: true })).toBeVisible();
        // The seeded user has no agents, so inline creation is the only agent
        // path and is selected by default.
        await expect(
          anonPage.getByRole("radio", { name: /Create a new agent/ })
        ).toBeChecked();
        await expect(anonPage.getByText(/Give it access to/)).toBeVisible();

        // Unnamed: not approvable, and the reason is on screen beside the
        // disabled button rather than hidden in the scroll region.
        const allow = anonPage.getByRole("button", { name: "Allow access" });
        await expect(allow).toBeDisabled();
        await expect(anonPage.getByText(/Name the new agent to continue/)).toBeVisible();

        // Unchecking everything is the dead-credential case, and it stays
        // blocked even once the agent has a name.
        await anonPage.getByRole("textbox", { name: "Name" }).fill(INLINE_AGENT_NAME);
        await expect(allow).toBeEnabled();
        const boxes = anonPage.getByRole("checkbox", { name: /E2E/ });
        const count = await boxes.count();
        for (let index = 0; index < count; index += 1) await boxes.nth(index).uncheck();
        await expect(allow).toBeDisabled();
        await expect(
          anonPage.getByText(/An agent with no workspace access would fail every request/)
        ).toBeVisible();
      });

      await test.step("the admin override is a disclosure, not a peer of the agent options, and needs a typed confirmation", async () => {
        // Not in the radio group: a list of peers is how something gets chosen
        // without being read.
        await expect(anonPage.getByRole("radio", { name: /yourself/i })).toHaveCount(0);

        // Collapsed, so the full membership enumeration is not even on screen
        // until the user deliberately opens it.
        const summaryLine = anonPage.getByText(
          /Everything you can reach — \d+ organizations? and \d+ workspaces?/
        );
        await expect(summaryLine).toBeHidden();

        await anonPage.getByText("Authorize as yourself instead").click();
        await expect(summaryLine).toBeVisible();

        // The enumeration must not undercount. A summary that says "1 workspace"
        // while granting four is worse than no summary at all.
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
          "the override must enumerate every workspace membership the user actually holds"
        ).toBe(Number(seeded.rows[0].workspaces));

        // Opening it changes nothing on its own.
        await expect(anonPage.getByRole("button", { name: "Allow full account access" })).toHaveCount(0);

        await anonPage.getByRole("checkbox", { name: /I understand this grants my full account access/ }).check();
        const destructive = anonPage.getByRole("button", { name: "Allow full account access" });
        await expect(destructive, "arming it relabels the primary action").toBeVisible();
        await expect(destructive, "…but the typed confirmation is still required").toBeDisabled();

        await anonPage.getByRole("textbox", { name: new RegExp(`Type ${DEV_USER_EMAIL}`) }).fill("wrong@example.com");
        await expect(destructive).toBeDisabled();
        await anonPage.getByRole("textbox", { name: new RegExp(`Type ${DEV_USER_EMAIL}`) }).fill(DEV_USER_EMAIL);
        await expect(destructive).toBeEnabled();

        // Collapsing disarms, so the screen cannot sit in its most dangerous
        // state with nothing visible to say so.
        await anonPage.getByText("Authorize as yourself instead").click();
        await expect(anonPage.getByRole("button", { name: "Allow access" })).toBeVisible();
      });

      await test.step("the client is visibly marked unverified despite calling itself official", async () => {
        await expect(anonPage.getByText("Unverified application")).toBeVisible();
        await expect(
          anonPage.getByText(/Compass does not review or verify the applications/i)
        ).toBeVisible();
      });

      await test.step("rendering the consent screen writes no approval cookie", async () => {
        // A drive-by GET — an <img> tag, a prefetch, a link in an email —
        // must not plant state a later request would honour as consent. Since
        // ADR 0015 the cookie is gone entirely, so this also guards against it
        // being reintroduced on the GET.
        const cookies = await anonContext.cookies();
        expect(
          cookies.map((cookie) => cookie.name),
          "a GET of /oauth/authorize must not write the consent cookie"
        ).not.toContain(RETIRED_CONSENT_COOKIE_NAME);
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

      // ── 7. Approve, creating the agent inline. ───────────────────────────
      const approved = newAuthorizationParams();
      let authorizationCode = "";
      await test.step("approving redirects to the registered redirect_uri with code, state and iss", async () => {
        await anonPage.goto(
          `/oauth/authorize?${authorizeQuery(loopbackClientId, loopbackRedirectUri, approved.state, approved.codeChallenge)}`
        );
        await expect(
          anonPage.getByRole("heading", { name: `Authorize ${LOOPBACK_CLIENT_NAME}` })
        ).toBeVisible();

        // Agent selection and grant selection are one interaction: naming the
        // agent is not enough on its own, and the default has every grantable
        // workspace checked precisely so the common case is not the blocked one.
        await anonPage.getByRole("textbox", { name: "Name" }).fill(INLINE_AGENT_NAME);
        await expect(anonPage.getByRole("checkbox", { name: /E2E Workspace/ })).toBeChecked();

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
        authorizationCode = callback.searchParams.get("code")!;

        expect(
          await codeCount(pool, loopbackClientId),
          "approval must write exactly one authorization code"
        ).toBe(1);
      });

      await test.step("the inline agent was created and granted through the ordinary grant model", async () => {
        const { rows } = await pool.query<{ id: string; grants: string }>(
          `SELECT a.id,
                  (SELECT COUNT(*)::text FROM "${SCHEMA}".agent_workspace_grants g
                    WHERE g.agent_id = a.id AND g.revoked_at IS NULL) AS grants
             FROM "${SCHEMA}".agents a
            WHERE a.name = $1`,
          [INLINE_AGENT_NAME]
        );
        expect(rows, "the consent screen must have created the agent").toHaveLength(1);
        expect(
          Number(rows[0].grants),
          "an agent with no grants is the dead credential the screen refuses to mint"
        ).toBeGreaterThan(0);
      });

      // ── 8. The assertion the whole change is for: the *token* is an agent. ─
      let accessToken = "";
      await test.step("the exchanged token resolves to purpose AGENT, not USER", async () => {
        const exchange = await request.post("/api/oauth/token", {
          form: {
            grant_type: "authorization_code",
            code: authorizationCode,
            redirect_uri: loopbackRedirectUri,
            client_id: loopbackClientId,
            code_verifier: approved.codeVerifier,
          },
        });
        expect(exchange.status(), "the code must exchange for a token").toBe(200);
        const tokens = await exchange.json();
        expect(tokens.access_token, "the exchange must return an access token").toBeTruthy();
        accessToken = tokens.access_token;

        // The column, because that is what validateOAuthAccessToken branches on.
        const stored = await pool.query<{ mode: string | null; agent: string | null }>(
          `SELECT authorization_mode AS mode, agent_id AS agent
             FROM "${SCHEMA}".oauth_tokens
            WHERE client_id = $1 AND type = 'ACCESS'`,
          [loopbackClientId]
        );
        expect(stored.rows[0].mode).toBe("AGENT");
        expect(stored.rows[0].agent).toBeTruthy();

        // …and the identity the server actually reports, because the column
        // only matters if the branch reads it. Phase 1 answered "USER" here
        // with every workspace attached; that is the gap being closed.
        const identity = await request.post("/api/mcp", {
          headers: {
            authorization: `Bearer ${tokens.access_token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          data: {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "get_current_identity", arguments: {} },
          },
        });
        expect(identity.status(), "an agent-bound token must authenticate").toBe(200);
        const body = await identity.text();
        expect(body, "get_current_identity must report an AGENT purpose").toContain('"AGENT"');
        expect(body).toContain(INLINE_AGENT_NAME);
        // Authentication stamps lastUsedAt asynchronously. Wait on the durable
        // value before navigating to Settings so the panel assertion cannot
        // race the intentionally fire-and-forget write.
        await expect.poll(async () => {
          const used = await pool.query<{ last_used_at: Date | null }>(
            `SELECT last_used_at FROM "${SCHEMA}".oauth_tokens
              WHERE client_id = $1 AND type = 'ACCESS'`,
            [loopbackClientId]
          );
          return used.rows[0]?.last_used_at ?? null;
        }).not.toBeNull();
      });

      // ── 8b. The connection remains inspectable and revocable from Settings.
      await test.step("Connected apps shows the binding and Revoke invalidates its bearer token", async () => {
        await anonPage.goto("/settings/agents");
        await expect(anonPage.getByRole("heading", { name: "Connected apps" })).toBeVisible();

        const connection = anonPage.locator("article").filter({ hasText: LOOPBACK_CLIENT_NAME });
        await expect(connection, "the exchanged client's connection must be listed").toHaveCount(1);
        await expect(connection).toContainText(`127.0.0.1:${callbackPort}`);
        await expect(connection).toContainText(INLINE_AGENT_NAME);
        await expect(connection).toContainText("mcp:read, mcp:write, offline_access");
        await expect(connection).toContainText("E2E Test Org · E2E Workspace · Read and write");
        await expect(connection.getByText("Never", { exact: true }), "the MCP call must update last-used").toHaveCount(0);

        await connection.getByRole("button", { name: `Revoke ${LOOPBACK_CLIENT_NAME}` }).click();
        await expect(connection, "revoking must remove the remembered connection").toHaveCount(0);

        const revokedIdentity = await request.post("/api/mcp", {
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          data: {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name: "get_current_identity", arguments: {} },
          },
        });
        expect(revokedIdentity.status(), "a revoked Connected Apps token must fail authentication").toBe(401);
      });

      // ── 9. Selecting an existing agent, including the zero-reach refusal. ─
      //      Run against the hosted client, which has no consent row yet.
      await test.step("an agent with no grants is shown, selectable, and refused", async () => {
        await pool.query(
          `INSERT INTO "${SCHEMA}".agents (id, owner_user_id, name, status, created_at, updated_at)
           SELECT gen_random_uuid(), u.id, $1, 'ACTIVE', NOW(), NOW()
             FROM "${SCHEMA}".users u WHERE u.email = $2`,
          [SEEDED_AGENT_NAME, DEV_USER_EMAIL]
        );

        const picked = newAuthorizationParams();
        await anonPage.goto(
          `/oauth/authorize?${authorizeQuery(hostedClientId, HOSTED_REDIRECT_URI, picked.state, picked.codeChallenge)}`
        );
        const radio = anonPage.getByRole("radio", { name: new RegExp(SEEDED_AGENT_NAME) });
        await expect(radio, "an existing agent must be offered").toBeVisible();
        await expect(
          anonPage.getByText(/No workspace access — cannot be used for this connection/)
        ).toBeVisible();

        await radio.check();
        // Selecting an existing agent offers no grant editing: widening a
        // long-lived agent's standing reach from a screen the application named
        // would be a privilege change smuggled into an authorization flow.
        await expect(anonPage.getByRole("checkbox", { name: /E2E Workspace/ })).toHaveCount(0);

        const allow = anonPage.getByRole("button", { name: "Allow access" });
        await expect(allow, "a zero-reach agent must not be approvable").toBeDisabled();
        await expect(
          anonPage.getByText(/has not been granted access to any workspace/)
        ).toBeVisible();
        expect(
          await codeCount(pool, hostedClientId),
          "a blocked screen must not have issued anything"
        ).toBe(0);
      });

      await test.step("granting that agent access unblocks the same selection", async () => {
        await pool.query(
          `INSERT INTO "${SCHEMA}".agent_workspace_grants
             (id, agent_id, workspace_id, access, granted_by_user_id, created_at, updated_at)
           SELECT gen_random_uuid(), a.id, w.id, 'WRITE', u.id, NOW(), NOW()
             FROM "${SCHEMA}".agents a
             JOIN "${SCHEMA}".users u ON u.email = $2
             JOIN "${SCHEMA}".workspace_members m ON m.user_id = u.id
             JOIN "${SCHEMA}".workspaces w ON w.id = m.workspace_id AND w.name = 'E2E Workspace'
            WHERE a.name = $1
            LIMIT 1`,
          [SEEDED_AGENT_NAME, DEV_USER_EMAIL]
        );

        await anonPage.reload();
        await anonPage.getByRole("radio", { name: new RegExp(SEEDED_AGENT_NAME) }).check();
        await expect(anonPage.getByRole("button", { name: "Allow access" })).toBeEnabled();
        // The reach shown is the grant, not the membership — one workspace,
        // where the user belongs to several.
        await expect(
          anonPage.getByText(/E2E Workspace · .* · read and write/)
        ).toBeVisible();
      });
    } finally {
      await anonContext.close();
    }
  } finally {
    for (const name of [SEEDED_AGENT_NAME, INLINE_AGENT_NAME]) {
      await pool.query(
        `DELETE FROM "${SCHEMA}".agent_workspace_grants
          WHERE agent_id IN (SELECT id FROM "${SCHEMA}".agents WHERE name = $1)`,
        [name]
      );
      await pool.query(`DELETE FROM "${SCHEMA}".agents WHERE name = $1`, [name]);
    }
    for (const clientId of registeredClientIds) {
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_authorization_events WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_authorization_codes WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_tokens WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_consents WHERE client_id = $1`, [clientId]);
      await pool.query(`DELETE FROM "${SCHEMA}".oauth_clients WHERE client_id = $1`, [clientId]);
    }
    await pool.end();
    await new Promise<void>((resolve) => callbackServer.close(() => resolve()));
  }
});
