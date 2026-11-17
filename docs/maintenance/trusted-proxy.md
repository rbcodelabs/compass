# Trusted proxy

`COMPASS_TRUSTED_PROXY` chooses which forwarded headers Compass believes. It is
read in `lib/trusted-proxy.ts` and used for the client address (the OAuth
registration rate limit), the request host (the account deletion same-origin
check) and the host and protocol used to build the embedder origin for v0 preview
frames.

| Value | Client address | Host | Protocol |
| --- | --- | --- | --- |
| `vercel` (default) | `x-real-ip`, else the first `x-forwarded-for` entry | `x-forwarded-host`, else `host` | `x-forwarded-proto` |
| `alb` | The right-most `x-forwarded-for` entry, or the Nth from the right with `COMPASS_TRUSTED_PROXY_HOPS=N` | `host` | `x-forwarded-proto` |
| `none` | `unknown` for every caller | `host` | Not trusted |

Why `alb` reads from the right: an ALB appends the address of the peer that
connected to it to the end of `x-forwarded-for`. Anything to the left is
whatever the client sent, so the first entry is spoofable. An ALB does not set
`x-real-ip` or `x-forwarded-host`, so a client can send them and they are
ignored. If a CDN sits in front of the ALB and also appends (CloudFront then ALB),
set `COMPASS_TRUSTED_PROXY_HOPS=2` so the address two from the right is used.
With fewer entries than hops, the left-most entry is used.

An unrecognised `COMPASS_TRUSTED_PROXY`, or a `COMPASS_TRUSTED_PROXY_HOPS` that is
not a whole number from 1 to 99, throws on first use instead of falling back to
a trusting mode.

Default: `vercel`, which is the behaviour Compass had before this setting existed, so a Vercel deployment needs no change.
