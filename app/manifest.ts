import type { MetadataRoute } from "next";

// Installable-PWA manifest. Colours mirror the Ledger tokens in globals.css:
// background_color is --background (paper) and theme_color is
// --surface-navigation (inset) so the installed window's title bar blends with
// the sidebar. The dark title bar colour comes from the viewport themeColor
// media pair in app/layout.tsx (a manifest carries only one colour).
// No service worker on purpose: install does not need one, and caching
// authenticated pages would risk leaking data across sessions.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Compass",
    short_name: "Compass",
    description: "Product discovery platform.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#FAF9F6",
    theme_color: "#F4F2ED",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
