import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
