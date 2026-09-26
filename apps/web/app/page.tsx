import { SiteHeader } from "@/components/site/header";
import { SiteFooter } from "@/components/site/footer";
import { Hero } from "@/components/hero/hero";
import { DefaultsStrip } from "@/components/sections/defaults-strip";
import { LoopSection } from "@/components/sections/loop";
import { RadarSection } from "@/components/sections/radar";
import { MarketSection } from "@/components/sections/market";
import { EconomicsSection } from "@/components/sections/economics";
import { ProductionSection } from "@/components/sections/production";
import { RoutingSection } from "@/components/sections/routing";
import { SupervisionSection } from "@/components/sections/supervision";
import { LearningSection } from "@/components/sections/learning";
import { FinalCta } from "@/components/sections/final-cta";

// Navigation and CTAs depend on the visitor's session, resolved per request on the server,
// so the first HTML byte already carries the right state (no client-side auth flash).
export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Hero />
        <DefaultsStrip />
        <LoopSection />
        <RadarSection />
        <MarketSection />
        <EconomicsSection />
        <ProductionSection />
        <RoutingSection />
        <SupervisionSection />
        <LearningSection />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
