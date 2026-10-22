---
title: "Connected MCP servers"
description: "Let the Compass agent call a third-party MCP server on your behalf without handing it the credential"
icon: "Plug"
order: 23
section: "Configuration"
---

# Connected MCP servers

The Compass in-app agent normally has exactly one tool provider: Compass itself.
A connector adds another. Connect a third-party MCP server once, and the agent
can call that server's tools during a turn the same way it calls Compass's.

This is the opposite direction from **Connected apps** on the same settings page.
Connected apps are applications you have allowed to reach *into* Compass.
Connectors are servers Compass reaches *out* to on your behalf. The distinction
matters when you want to revoke something: a connected app is revoked here, while
a connector's authorization also exists at the provider.

## Connect a server

1. Open **Settings → Agents** and find **Connected MCP servers**.
2. Choose **Connect** next to the server you want. Compass sends you to that
   provider's own sign-in and consent screen.
3. Approve there. The provider returns you to this page, which then shows the
   server as connected to your account.

Some servers let you choose how much access to grant before you connect (Google
Drive: **Read and write**, or **Read only**). The choice is a set of radio
buttons next to **Connect**, and the first option is preselected. It is yours
alone: another person connecting the same server picks their own.

To change the level later, use the **Reconnect** links shown under a connected
server. The level is the permission the provider actually issued, so changing it
means authorizing again; Compass cannot widen or narrow an existing token.

A connection belongs to **you**, not to a workspace. Two people using the same
workspace each connect separately, and neither one's agent turns use the other's
authorization. This is deliberate: a shared token would let one person's agent
act as another person inside the third-party product, which has no way to tell
Compass users apart.

## What the agent can see

Compass holds the provider's token server-side and never passes it to the agent.
The agent is handed a Compass URL for each connected server plus its own
short-lived, single-user turn credential; Compass attaches the provider token as
the request leaves. So the sandbox the agent runs in holds one credential, scoped
to one person for one turn, and the third-party token stays on the Compass side.

Connected tools appear to the agent under a `mcp__<server>` prefix, alongside
Compass's own. Only servers you have connected are offered — a turn for someone
with no connections is identical to one before this feature existed.

## Disconnect

For a Vercel Connect-backed server (Google Drive), **Disconnect** revokes your
authorization in Vercel Connect, which holds the token; Compass keeps no copy.

For other servers, **Disconnect** always removes Compass's copy of the token immediately. Where the
provider supports it, Compass also revokes the token at the provider and says so.
Where it does not, the message tells you the token is gone from Compass and that
you may also want to remove Compass from that provider's own list of authorized
applications.

## Emergency revocation

This applies to connectors whose tokens Compass stores itself (v0). Google Drive
tokens live in Vercel Connect, not in Compass, so the sweep below cannot reach
them: to cut off Drive for everyone, revoke or delete the grants (or the whole
connector) in the Vercel Connect dashboard. Rows left in `mcp_connector_grants`
from before the move to Connect are unused and are still wiped by the sweep.

If `MCP_CONNECTOR_SECRET_ENCRYPTION_KEY` may have leaked, or a database dump may
have left the environment, treat every stored third-party token as compromised.
Operators can disconnect **everyone** at once with
`POST /api/admin/revoke-connector-grants`, authenticated with the
`x-migration-secret` header (the same credential as `/api/admin/migrate`).

**Run this before rotating the encryption key.** Asking a provider to revoke a
token needs the plaintext token, so the old key must still be configured.

1. **Dry run first.** `dryRun` defaults to `true`; only an explicit `false` writes.

   ```bash
   curl -s -X POST https://<host>/api/admin/revoke-connector-grants \
     -H "x-migration-secret: $MIGRATION_SECRET" \
     -H "Content-Type: application/json" -d '{}'
   ```

   The response lists how many grants would be touched per connector and whether
   Compass can tell that provider to revoke them.

2. **Revoke.** Send `{"dryRun": false}`. Optional `slug` (one connector, for
   example `"google-drive"`) and `userId` (one person) narrow the run.

3. **Repeat while `truncated` is `true`.** Work is chunked against a time budget,
   so a large install may need several calls. Re-sending the same body continues
   where the last call stopped and is safe to repeat.

4. **Then rotate** `MCP_CONNECTOR_SECRET_ENCRYPTION_KEY` and redeploy.

For each grant, Compass wipes its own copy first (status `REVOKED`, both tokens
blanked) and only then asks the provider to revoke, so a slow or unreachable
provider never leaves a token usable through Compass. The response contains
counts only, never tokens or user identifiers:

| Field | Meaning |
| --- | --- |
| `matched` | Grants that held tokens when the run started |
| `wiped` | Compass's copies removed |
| `providerRevoked` | The provider confirmed the revocation |
| `providerNotConfirmed` | The provider has no revocation endpoint, or did not confirm |
| `undecryptable` | Could not be opened with the current key: wiped locally, provider not told |
| `remaining` / `truncated` | Grants still holding tokens / whether to call again |

Compass wiping its copy does **not** by itself invalidate a token the provider has
already issued. For anything counted in `providerNotConfirmed` or `undecryptable`
(always the case if the old key is already gone), also:

- delete or rotate the OAuth client at the provider (for Google Drive, the OAuth
  client in Google Cloud Console; rotating only the client secret does
  **not** invalidate refresh tokens that were already issued), and/or
- ask users to remove Compass at the provider's authorized-apps page (for Google,
  myaccount.google.com/permissions).

One limit worth knowing: a token refresh running at the exact moment of the sweep
can mint a rotated token that is not revoked at the provider. Compass's copy of it
is still discarded; re-running the sweep after a minute, or removing the OAuth
client, closes that window.

## When a call takes too long

A single tool call through a connector has a time limit, and some third-party
operations legitimately run longer than that. When the limit is reached, the agent
is told that the call timed out **and that the work may have completed anyway** —
so it checks the provider's current state rather than assuming failure and
starting over. If a provider offers a start-then-poll pair of tools for
long-running work, prefer those; the agent is steered toward them where Compass
knows about them.

## Errors on the settings page

A failed connection reports a specific cause: the authorization was started from
a different Compass account, it expired or was already used, the provider declined
it, you declined it, or Compass could not complete token exchange, client
registration, or metadata discovery. Compass never repeats the provider's own
error text, since a response body can carry more than a message.

If the panel says connectors are not available on this deployment, the schema
migration below has not been applied yet.

## Deployment

Administrators must apply and verify migration `062_mcp_connectors`, and set
`MCP_CONNECTOR_SECRET_ENCRYPTION_KEY` for every environment that should offer
connectors. Preview and production are configured independently.

Until the migration is applied, Compass keeps working with its own MCP server
alone: the panel reports connectors as unavailable rather than failing, and agent
turns are unaffected. Without the encryption key, a connection attempt reports
that connector storage is not configured rather than storing a token it could not
protect.

### Google Drive

Google Drive offers two access levels, chosen by each person when they connect:

| Level | Google scope | What the agent can do |
|---|---|---|
| **Read and write** (default) | `https://www.googleapis.com/auth/drive` | Search and read your files and, when you ask, create, edit, move, trash or share them. |
| **Read only** | `https://www.googleapis.com/auth/drive.readonly` | Search and read files. Google refuses any change. |

Read only is enforced by Google, not by Compass: the token itself cannot write,
so a document that tricks the agent into attempting a change still fails. Prefer
it unless you need the agent to change files. The agent is also told which level
you chose, so with read only it says plainly that it cannot make a change and
points you to **Reconnect**, rather than trying.

With read and write, treat anything the agent reads from a Drive file as
untrusted: the agent is told not to follow instructions found in documents and to
change files only when you ask for that specific change, but you should still
disconnect Drive if you are not using it.

A link can also pick the level directly: `/api/connectors/google-drive/connect?access=read-only`
(or `access=full`). An unrecognised value is refused with a 400 rather than
falling back to broader access. Connections made before access levels existed
hold the broad scope and show as **Read and write**.

Unlike v0, Google offers no self-registration, and Compass does not hold a
Google OAuth client itself. Google Drive is served by a
[Vercel Connect](https://vercel.com/docs/connect) connector: Connect owns the
client id and secret, the consent screen, token storage and refresh, and Compass
asks it for a short-lived access token for the signed-in user each time the agent
needs one.

Administrators:

1. Create the Connect connector (for example `google/compass`), set
   `https://connect.vercel.com/callback` as an authorized redirect URI on the
   Google OAuth client, and enable the Google Drive MCP API in its Google Cloud
   project.
2. Link the connector to the Compass project for **each** environment that should
   offer Drive (Production and Preview are separate).
3. Set `COMPASS_GOOGLE_CONNECTOR` to the connector UID for those environments and
   redeploy. The UID differs per deployment, so there is no default.

Until `COMPASS_GOOGLE_CONNECTOR` is set, Google Drive shows as **Not configured
on this deployment** and cannot be connected. If the connector is not linked to
the project or environment, connecting fails with a message naming that cause.
Connecting Drive through the earlier Compass-hosted flow is gone: anyone who
connected before the move to Connect reconnects once in Settings → Agents.

The same variable enables **Continue with Google** on the sign-in page; with it
unset that button is hidden and magic link and passkey sign-in are unaffected.

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_GOOGLE_ID` and
`AUTH_GOOGLE_SECRET` are no longer read by Compass and can be removed from each
environment once production has been verified.
