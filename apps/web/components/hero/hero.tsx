import { ArrowRight } from "lucide-react";
import { AGENTS } from "@gigpilot/contracts";
import { siteUrls } from "@/lib/site";
import { getViewer } from "@/lib/session";
import { deliveredJobs, SOURCES } from "@/lib/demo-data";
import { LinkButton } from "@/components/site/link-button";
import { PilotCore, type CoreNode } from "./pilot-core";

const PIPELINE: { key: keyof typeof AGENTS; short: string; name?: string; role?: string }[] = [
  { key: "scout", short: "Scout" },
  { key: "analyst", short: "Analyst" },
  { key: "economics", short: "Economics" },
  { key: "proposal", short: "Proposal" },
  { key: "planner", short: "Planner" },
  {
    key: "creative",
    short: "Execution",
    name: "Execution agents",
    role: "Creative, coding, automation, research, copy, localisation and finishing agents run the workflow steps inside spend limits.",
  },
  { key: "qa", short: "QA" },
];

function node(key: keyof typeof AGENTS, short: string, name?: string, role?: string): CoreNode {
  return { name: name ?? AGENTS[key].name, short, role: role ?? AGENTS[key].role };
}

export async function Hero() {
  const { signedIn } = await getViewer();
  const urls = siteUrls();

  return (
    <section aria-labelledby="hero-title" className="relative overflow-x-clip pb-8 pt-10 sm:pt-14 xl:pt-12">
      <div className="site-container">
        <div className="grid gap-7 xl:grid-cols-12 xl:items-end xl:gap-6">
          <div className="xl:col-span-7">
            <p className="label flex items-center gap-2.5">
              <span className="relative inline-flex size-1.5">
                <span className="absolute inset-0 animate-pulse-dot rounded-full bg-profit text-profit" />
              </span>
              Private beta — opportunity-to-delivery OS
            </p>
            <h1 id="hero-title" className="display-1 mt-5">
              Find profitable work.
              <br />
              <span className="text-fg-2">Win it. Get it done.</span>
            </h1>
          </div>
          <div className="xl:col-span-5 xl:pb-1.5 xl:pl-8">
            <p className="max-w-[560px] text-[16px] leading-[26px] text-fg-2 sm:text-[17px] sm:leading-[27px] xl:text-[16px] xl:leading-[26px]">
              GigPilot watches the marketplaces you&apos;re allowed to watch, prices every opportunity deterministically, and coordinates
              specialist AI agents to deliver the work. You approve three things:{" "}
              <span className="text-fg">what to pursue, what to commit to, and what ships.</span>
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {signedIn ? (
                <LinkButton href={urls.app} size="lg" data-testid="hero-dashboard">
                  Go to Dashboard
                  <ArrowRight aria-hidden className="size-4 transition-transform group-hover/btn:translate-x-0.5" strokeWidth={2} />
                </LinkButton>
              ) : (
                <>
                  <LinkButton href={urls.signup} size="lg" data-testid="hero-signup">
                    Sign up
                    <ArrowRight aria-hidden className="size-4 transition-transform group-hover/btn:translate-x-0.5" strokeWidth={2} />
                  </LinkButton>
                  <LinkButton href={urls.login} variant="outline" size="lg" data-testid="hero-login">
                    Log in
                  </LinkButton>
                </>
              )}
              <span className="text-[13px] leading-5 text-fg-muted sm:ml-2">Starts in mock mode · $0 paid spend</span>
            </div>
          </div>
        </div>

        <div className="mt-10 lg:mt-12">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-3">
            <p className="label">
              <span className="text-fg">Pilot Core</span> — a live model of the loop
            </p>
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5" aria-label="Legend">
              <Legend glyph={<span className="size-[5px] rounded-full bg-fg" />} label="Signal" />
              <Legend glyph={<span className="size-[7px] rounded-full bg-accent" />} label="Profitable job" />
              <Legend glyph={<span className="size-[7px] rotate-45 ring-[1.25px] ring-accent" />} label="Owner approval" />
              <Legend glyph={<span className="h-0 w-3 border-t border-dashed border-warn" />} label="QA → Recovery" />
              <Legend glyph={<span className="h-0 w-3 border-t border-dashed border-profit" />} label="Learning" />
            </ul>
          </div>
          <PilotCore
            sources={SOURCES}
            stations={PIPELINE.map((p) => node(p.key, p.short, p.name, p.role))}
            orchestrator={node("orchestrator", "Orchestrator")}
            recovery={node("recovery", "Recovery")}
            market={node("market_research", "Market research")}
            jobs={deliveredJobs()}
          />
        </div>
      </div>
    </section>
  );
}

function Legend({ glyph, label }: { glyph: React.ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.08em] text-fg-muted">
      <span aria-hidden className="inline-flex size-3 items-center justify-center">
        {glyph}
      </span>
      {label}
    </li>
  );
}
