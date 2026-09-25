import type { Metadata, Viewport } from "next";
import { fontVariables } from "@gigpilot/ui/fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.CANONICAL_WEB_URL ?? "https://gigpilot.ai"),
  title: { default: "GigPilot — Find profitable work. Win it. Get it done.", template: "%s · GigPilot" },
  description:
    "GigPilot is an agentic operating system that finds opportunities, understands what they require, calculates whether they're worth doing, and coordinates AI agents to complete the work.",
};

export const viewport: Viewport = { themeColor: "#08090b", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
