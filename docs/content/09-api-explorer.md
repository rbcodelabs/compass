---
title: "API Explorer Guide"
description: "Browse the generated Compass API contract and safely try reads"
icon: "Braces"
order: 9.1
section: "Developer"
---

# API Explorer

Open the [interactive API explorer](/help/api-explorer) to search the operations
published by this Compass deployment. Its catalog, parameters and schemas come
from the same [OpenAPI document](/api/v1/openapi.json) used by generated clients.
The [REST API guide](/help/09-rest-api) explains authentication, pagination and
authorization boundaries.

## Browse the contract

Search by resource, HTTP method, path, summary or operation ID. Choose an operation
in the resource sidebar; on mobile, use **Browse operations**. The Request tab shows
parameters and any documented request body. Schema shows success and problem
responses, including local references and a raw-operation fallback. Examples
contains cURL and JavaScript with synthetic values and a `<token>` placeholder.

Operation deep links contain only the operation ID. They never contain entered
credentials or resource identifiers. A link to an operation missing from the current
deployment asks you to select another operation.

## Try a read

Only documented **GET** operations can execute. Writes remain browsable but cannot
be sent from this explorer. Supply required parameters, paste a Compass API key
or an already-issued OAuth bearer token, then choose **Send GET request**. Signing
in to Compass in the browser does not authenticate API requests.

Requests go directly to `/api/v1` on this deployment, without browser cookies.
Redirects are rejected. Requests access real private data under the supplied
token's permissions: do not use the explorer on an untrusted computer. No requests
run automatically, including pagination; enter a returned cursor and explicitly
send again when you want the next page.

The Response tab shows status, elapsed time, content type and safely rendered
JSON or text. Requests time out after 30 seconds and can be cancelled. Response
display is limited to 128 KiB and marks truncated content.

## Credential privacy

Credentials, entered parameters and responses stay in this page's memory. They
are not saved in browser storage, URLs, analytics or examples. **Reset session**
clears all three and cancels any pending request. Reloading or leaving the page
clears the session. Examples always use placeholders, never your entered token
or private parameter values.

The explorer does not issue OAuth tokens, select another environment, proxy
requests or bypass API permissions. A `401`, `403` or `404` response reflects the
normal REST authentication and tenant boundaries.
