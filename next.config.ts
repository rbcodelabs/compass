import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  devIndicators: false,
  // Load these server-only SDKs via Node require at runtime instead of bundling
  // them. In `next dev` this keeps their sources out of Turbopack's module
  // graph, cutting next-server RssAnon by ~25% (cold) / ~12% (warm) on a
  // fixed 15-route workspace walk. They are only used in route handlers and
  // server modules, never imported by client code.
  serverExternalPackages: [
    "@modelcontextprotocol/sdk",
    "mcp-handler",
    "@vercel/sandbox",
    "@aws-sdk/dsql-signer",
    "jose",
    "gray-matter",
  ],
  // assertReviewedMigrationCode() reads migration SQL and reviewed migration
  // code by a runtime-computed path, which Next cannot trace statically (it
  // used to fall back to tracing the whole repo, ~1,900 files / ~37 MB, into
  // every function that imports it). Name exactly what those routes read.
  outputFileTracingIncludes: {
    "/api/admin/migrate": ["./prisma/migrations/**/migration.sql", "./lib/migrations/*.ts"],
    "/api/preview-automation/*": ["./prisma/migrations/**/migration.sql", "./lib/migrations/*.ts"],
    // The agent turn route reads its sandbox entry script and helper modules from disk at
    // request time and writes them into the sandbox. Nothing imports them, so the file
    // tracer only keeps them if told to; without them every agent turn would die with ENOENT.
    "/api/agent/turn": ["./scripts/agent/**/*"],
    // A run can also start from an assignment or a Doc comment mention (lib/agent-task-trigger.ts, lib/agent-run-launch.ts), which
    // run inside whichever task, doc, panel or settings route the person was using, so every route that can reach them needs the
    // same files. They are small (about 130 KB), and naming each caller would silently break the next one added.
    "/**": ["./scripts/agent/**/*"],
  },
  async headers() {
    return [
      {
        // The OAuth consent screen. Clickjacking is the specific attack these
        // defend against: framed inside an attacker's page, "Allow access" can
        // be positioned under an innocuous-looking button and clicked by a
        // signed-in user who never saw what they approved. `frame-ancestors`
        // is the modern control and `X-Frame-Options` covers the browsers that
        // still only honour the legacy header — both, because the cost is two
        // lines and the failure mode is silent.
        source: "/oauth/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // The URL carries `state` and `code_challenge`, and the page names
          // every organization and workspace the user belongs to.
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // The embedded widget's sign-in popup, for the same reasons plus one more.
        // Clickjacking first: this page asks for an email address and is opened
        // from a page Compass does not control, so the operator of that page must
        // not be able to wrap it — the visitor's only assurance that they are
        // typing into Compass and not into the prototype is the address bar, and
        // framing takes that away.
        //
        // `Referrer-Policy` is load-bearing here rather than merely tidy. This URL
        // carries the handoff nonce, and knowing that nonce is momentarily enough
        // to claim a scoped visitor token (see lib/embed-visitor.ts). A referrer
        // header would hand it to any third party the page ever requested
        // something from.
        source: "/embed/signin",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      {
        // External artifact share (/s/<token>). The URL itself is the first credential,
        // so: no Referrer (the token must not ride out in a header to anything the page
        // loads), no caching of the unlocked page, no indexing, and no framing (the
        // password form is a phishing/clickjacking target like the consent screen).
        source: "/s/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
      {
        // The widget script. Cached, but only briefly, and the short ceiling is the
        // point rather than a compromise: this file is loaded by pages Compass does
        // not deploy and cannot redeploy, so a stale copy cannot be flushed by
        // shipping anything — the only lever is how long a browser is willing to
        // hold it. Five minutes lets a fix propagate on its own while still
        // absorbing the repeat views of a single review session. `must-revalidate`
        // rather than `immutable` because this URL carries no version or content
        // hash, so a cached copy has no way to notice it has been superseded.
        source: "/embed/widget.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
          // Served to pages Compass does not control, so: don't let a browser
          // second-guess the type, and don't leak the embedding page's URL if the
          // script ever causes a subresource request.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        // Vendored third-party libraries the widget loads at runtime. Cached far
        // harder than the widget itself, because these bytes are pinned to a
        // published release and verified by the sha256 recorded in each file's own
        // header — an upgrade arrives as a reviewed commit, not as a silent change
        // under the same path. Still not `immutable`, for the same reason as above:
        // there is no version in the URL.
        source: "/vendor/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
