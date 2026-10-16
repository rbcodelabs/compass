import type { Metadata } from "next";
import localFont from "next/font/local";
import { ProductAnalytics } from "@/components/product-analytics";
import "./globals.css";

// Fonts are self-hosted from @fontsource packages (latin subset woff2) via
// next/font/local rather than next/font/google. next/font/google fetches from
// Google at build time, and a transient failure there broke `next build`
// ("Can't resolve '@vercel/turbopack-next/internal/font/google/font'").
// Variable fonts cover the weight range the app uses (300-700); Poppins has no
// variable build, so each weight is its own static file.
const jakartaSans = localFont({
  variable: "--font-jakarta",
  src: "../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2",
  weight: "200 800",
  display: "swap",
});

const geistMono = localFont({
  variable: "--font-geist-mono",
  src: "../node_modules/@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2",
  weight: "100 900",
  display: "swap",
});

// ── Curated workspace-branding font presets ──────────────────────────────
// Each of these is a selectable option in Settings → Branding (see
// lib/branding-presets.ts). Defining an unused CSS variable costs nothing —
// this is the standard next/font multi-font pattern — so all of them are
// loaded unconditionally and added to <html> below regardless of which
// (if any) workspace actually picks them.
const inter = localFont({
  variable: "--font-inter",
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "100 900",
  display: "swap",
});

const poppins = localFont({
  variable: "--font-poppins",
  src: [
    {
      path: "../node_modules/@fontsource/poppins/files/poppins-latin-300-normal.woff2",
      weight: "300",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource/poppins/files/poppins-latin-400-normal.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource/poppins/files/poppins-latin-500-normal.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource/poppins/files/poppins-latin-600-normal.woff2",
      weight: "600",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource/poppins/files/poppins-latin-700-normal.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  display: "swap",
});

const spaceGrotesk = localFont({
  variable: "--font-space-grotesk",
  src: "../node_modules/@fontsource-variable/space-grotesk/files/space-grotesk-latin-wght-normal.woff2",
  weight: "300 700",
  display: "swap",
});

const sourceSerif = localFont({
  variable: "--font-source-serif",
  src: "../node_modules/@fontsource-variable/source-serif-4/files/source-serif-4-latin-wght-normal.woff2",
  weight: "200 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Compass",
    template: "%s · Compass",
  },
  description:
    "Product discovery platform. Connect customer opportunities to OKRs, run experiments, and ship with confidence.",
  metadataBase: new URL("https://compass.rbcodelabs.com"),
  // Site-wide no-referrer policy. This is the referrer-policy decision that
  // PR #282 deliberately left open before mounting <ProductAnalytics /> below
  // (see docs/content/09-mcp-api.md and ADR fbc69bbe-7053-4e1a-a5e1-281015bb592a
  // in Compass): it suppresses the Referer header/document.referrer on every
  // outbound navigation and subresource request from this app, not just on
  // analytics traffic.
  referrer: "no-referrer",
  openGraph: {
    title: "Compass",
    description: "Product discovery, powered by outcomes.",
    url: "https://compass.rbcodelabs.com",
    siteName: "Compass",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Compass",
    description: "Product discovery, powered by outcomes.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${jakartaSans.variable} ${geistMono.variable} ${inter.variable} ${poppins.variable} ${spaceGrotesk.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <ProductAnalytics />
      </body>
    </html>
  );
}
