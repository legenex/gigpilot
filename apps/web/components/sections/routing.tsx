import { Section, SectionIntro } from "@/components/site/section";
import { DEFAULTS } from "@/lib/demo-data";
import { LazyCreativeBroker, LazyRouterDiagram } from "./lazy-visuals";

export function RoutingSection() {
  return (
    <Section id="routing" index="06" name="Model & provider routing" stage="Build" labelledBy="routing-title">
      <SectionIntro
        id="routing-title"
        title="The right model for each task. The cheapest route that clears the bar."
        lead="Cheap, repetitive work runs on the local GX cluster at zero marginal cost. Reasoning goes through Factory's router. Live research goes to Grok. Creative work goes to a broker that ranks Kie.ai and Higgsfield routes by cost per usable asset — not sticker price."
      />
      <div className="mt-14 grid gap-14 lg:mt-16 lg:grid-cols-12 lg:gap-6">
        <div className="reveal lg:col-span-6">
          <p className="label mb-5 border-b border-line pb-3">Model router · task class → provider</p>
          <LazyRouterDiagram />
          <p className="mt-6 text-[13.5px] leading-[21px] text-fg-muted">
            Missing credentials put a provider in <span className="font-mono text-fg-2">needs_configuration</span> and fall back to mock
            mode — never a crash. Every call carries a cost ceiling that paid providers check before they run.
          </p>
        </div>
        <div className="reveal-late lg:col-span-6">
          <p className="label mb-5 border-b border-line pb-3">Creative broker · cost per usable asset</p>
          <LazyCreativeBroker defaultThreshold={DEFAULTS.routing.creativeQualityThreshold} />
          <p className="mt-4 text-[13.5px] leading-[21px] text-fg-muted">
            Priors come from the price catalog; after five attempts on a route, observed usable rates replace them. Drag the bar and watch
            the choice change.
          </p>
        </div>
      </div>
    </Section>
  );
}
