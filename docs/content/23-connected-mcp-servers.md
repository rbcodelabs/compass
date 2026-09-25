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

**Disconnect** always removes Compass's copy of the token immediately. Where the
provider supports it, Compass also revokes the token at the provider and says so.
Where it does not, the message tells you the token is gone from Compass and that
you may also want to remove Compass from that provider's own list of authorized
applications.

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
