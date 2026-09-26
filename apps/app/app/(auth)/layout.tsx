import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isSignedIn } from "@gigpilot/auth";
import { Logo } from "@gigpilot/ui";
import { AuthReadout } from "./readout";

export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const { signedIn } = await isSignedIn(await headers());
  if (signedIn) redirect("/");
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.1fr)_minmax(440px,0.9fr)]">
      <section className="relative hidden overflow-hidden border-r border-line bg-bg-raised lg:flex lg:flex-col" aria-label="About GigPilot">
        <div aria-hidden className="pointer-events-none absolute inset-0 [background-image:linear-gradient(var(--gp-line)_1px,transparent_1px),linear-gradient(90deg,var(--gp-line)_1px,transparent_1px)] [background-size:56px_56px] [mask-image:radial-gradient(ellipse_at_30%_40%,black,transparent_75%)] opacity-60" />
        <div className="relative flex h-full flex-col px-12 py-10 xl:px-16">
          <Logo />
          <div className="my-auto max-w-[560px] py-12">
            <p className="eyebrow mb-4">Opportunity-to-delivery OS</p>
            <h1 className="font-display text-[44px] font-semibold leading-[1.02] tracking-[-0.035em] text-fg xl:text-[52px]">
              Find profitable work.
              <br />
              Win it. <span className="text-fg-3">Get it done.</span>
            </h1>
            <p className="mt-5 max-w-[460px] text-[15px] leading-6 text-fg-2">
              GigPilot sources permitted opportunities, prices them deterministically, drafts the proposal and ships the work. You approve the moments that
              matter.
            </p>
            <AuthReadout />
          </div>
          <dl className="grid grid-cols-3 gap-6 border-t border-line pt-6">
            {[
              ["50%", "minimum margin gate"],
              ["$300", "minimum expected profit"],
              ["$0", "paid spend until you set a budget"],
            ].map(([v, l]) => (
              <div key={l}>
                <dt className="sr-only">{l}</dt>
                <dd className="font-display text-[22px] font-semibold tracking-[-0.02em] text-fg">{v}</dd>
                <dd className="mt-0.5 text-xs text-fg-3">{l}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
      <main className="flex min-h-dvh flex-col px-5 py-8 sm:px-10">
        <div className="lg:hidden">
          <Logo />
        </div>
        <div className="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center py-10">{children}</div>
        <p className="text-center text-[11px] text-fg-3">No scraping. No auto-apply. Every commitment waits for you.</p>
      </main>
    </div>
  );
}
