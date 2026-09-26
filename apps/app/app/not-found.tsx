import Link from "next/link";
import { Logo } from "@gigpilot/ui";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="max-w-sm">
        <Logo />
        <p className="eyebrow mb-2 mt-10">404</p>
        <h1 className="font-display text-[24px] font-semibold tracking-[-0.02em] text-fg">Page not found</h1>
        <p className="mt-2 text-[13px] text-fg-2">
          <Link href="/" className="text-fg underline-offset-4 hover:underline">
            Back to the Command Center
          </Link>
        </p>
      </div>
    </main>
  );
}
