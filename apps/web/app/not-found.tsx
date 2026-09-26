import Link from "next/link";
import { Logo } from "@gigpilot/ui";

export default function NotFound() {
  return (
    <main id="main" className="site-container flex min-h-[80vh] flex-col justify-center py-24">
      <Link href="/" aria-label="GigPilot home" className="focus-ring w-fit rounded-sm">
        <Logo />
      </Link>
      <p className="label mt-16">404 · off course</p>
      <h1 className="display-2 mt-4 max-w-[16ch]">This heading doesn&apos;t lead anywhere.</h1>
      <p className="mt-5 max-w-[480px] text-[17px] leading-[28px] text-fg-2">The page you asked for doesn&apos;t exist. The loop starts on the home page.</p>
      <Link href="/" className="focus-ring mt-8 w-fit rounded-sm text-[15px] font-medium text-accent-hi hover:text-accent">
        Back to GigPilot →
      </Link>
    </main>
  );
}
