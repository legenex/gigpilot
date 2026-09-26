import { ArrowRight } from "lucide-react";
import { getViewer } from "@/lib/session";
import { siteUrls } from "@/lib/site";
import { LinkButton } from "@/components/site/link-button";
import { CtaRing } from "./cta-ring";

export async function FinalCta() {
  const { signedIn } = await getViewer();
  const urls = siteUrls();
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden border-t border-line py-24 sm:py-32 lg:py-40">
      <div className="site-container grid items-center gap-12 lg:grid-cols-12 lg:gap-6">
        <div className="relative z-[1] lg:col-span-7">
          <p className="label">Early access · open sign-up</p>
          <h2 id="cta-title" className="display-1 mt-5 max-w-[14ch]">
            Your next profitable job is already posted.
          </h2>
          <p className="mt-6 max-w-[520px] text-[17px] leading-[28px] text-fg-2 lg:text-lead">
            Let GigPilot find it, price it and do the work. You make three decisions.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3" data-cta-watch>
            {signedIn ? (
              <LinkButton href={urls.app} size="lg" data-testid="cta-dashboard">
                Go to Dashboard
                <ArrowRight aria-hidden className="size-4 transition-transform group-hover/btn:translate-x-0.5" strokeWidth={2} />
              </LinkButton>
            ) : (
              <>
                <LinkButton href={urls.signup} size="lg" data-testid="cta-signup">
                  Sign up
                  <ArrowRight aria-hidden className="size-4 transition-transform group-hover/btn:translate-x-0.5" strokeWidth={2} />
                </LinkButton>
                <LinkButton href={urls.login} variant="outline" size="lg" data-testid="cta-login">
                  Log in
                </LinkButton>
              </>
            )}
          </div>
        </div>
        {/* Decorative instrument: desktop only — on narrow screens it only pushes the footer away. */}
        <div className="hidden lg:col-span-5 lg:block">
          <CtaRing />
        </div>
      </div>
    </section>
  );
}
