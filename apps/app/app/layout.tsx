import type { Metadata, Viewport } from "next";
import { fontVariables } from "@gigpilot/ui/fonts";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.CANONICAL_APP_URL ?? "https://app.gigpilot.ai"),
  title: { default: "GigPilot", template: "%s · GigPilot" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#08090b", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
