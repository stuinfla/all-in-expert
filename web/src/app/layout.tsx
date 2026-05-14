import type { Metadata } from "next";
import { Fraunces, Inter_Tight, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  axes: ["SOFT", "WONK", "opsz"],
  display: "swap",
});

const interTight = Inter_Tight({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://asktheallinexperts.vercel.app"),
  title: "Ask the All-In Experts",
  description:
    "Intelligence from 186+ episodes of the All-In Podcast. Ask what Chamath, Sacks, Friedberg, Jason and the guest besties would think about any topic. Real citations, real forecasts.",
  openGraph: {
    title: "Ask the All-In Experts",
    description: "5.8 million words. Four minds (plus guests). One intelligence system.",
    type: "website",
    url: "https://asktheallinexperts.vercel.app",
    siteName: "Ask the All-In Experts",
    images: [
      {
        url: "/icon-512.png",
        width: 512,
        height: 512,
        alt: "Ask the All-In Experts",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Ask the All-In Experts",
    description: "5.8 million words. Four minds (plus guests). One intelligence system.",
    images: ["/icon-512.png"],
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
      className={`${fraunces.variable} ${interTight.variable} ${jetbrainsMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[var(--bg)] text-[var(--ink)]">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
