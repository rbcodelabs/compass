import type { Metadata } from "next";
import {
  Plus_Jakarta_Sans,
  Geist_Mono,
  Inter,
  Poppins,
  Space_Grotesk,
  Source_Serif_4,
} from "next/font/google";
import "./globals.css";

const jakartaSans = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// ── Curated workspace-branding font presets ──────────────────────────────
// Each of these is a selectable option in Settings → Branding (see
// lib/branding-presets.ts). Defining an unused CSS variable costs nothing —
// this is the standard next/font multi-font pattern — so all four are
// loaded unconditionally and added to <html> below regardless of which
// (if any) workspace actually picks them.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  display: "swap",
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
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
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
