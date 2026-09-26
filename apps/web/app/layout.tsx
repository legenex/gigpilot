import type { Metadata, Viewport } from "next";
import { fontVariables } from "@gigpilot/ui/fonts";
import { MotionProvider } from "@/components/motion/motion-provider";
import "./globals.css";

const canonical = process.env.CANONICAL_WEB_URL ?? "https://gigpilot.ai";
const title = "GigPilot — Find profitable work. Win it. Get it done.";
const description =
  "GigPilot is an agentic operating system that finds opportunities, understands what they require, calculates whether they're worth doing, and coordinates AI agents to complete the work.";

export const metadata: Metadata = {
  metadataBase: new URL(canonical),
  title: { default: title, template: "%s · GigPilot" },
  description,
  applicationName: "GigPilot",
  alternates: { canonical: "/" },
  keywords: ["AI agents", "freelance automation", "opportunity scoring", "agentic operating system", "profitability calculator"],
  openGraph: {
    type: "website",
    url: "/",
    siteName: "GigPilot",
    title,
    description,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = { themeColor: "#08090b", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>
        <a
          href="#main"
          className="sr-only z-[100] rounded-sm bg-accent px-3 py-2 text-[13px] font-semibold text-[#1a0a02] focus:not-sr-only focus:fixed focus:left-4 focus:top-3"
        >
          Skip to content
        </a>
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
