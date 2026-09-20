import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  devIndicators: false,
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
    ];
  },
};

export default nextConfig;
